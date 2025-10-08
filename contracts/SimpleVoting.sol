// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Secp256k1} from "./lib/Secp256k1.sol";
import {EllipticCurve} from "./lib/EllipticCurve.sol";

/// @title Commit-Reveal voting contract for permissioned PoS networks
/// @notice One proposal per contract. Each credential commits a vote hash and reveals later within the configured window.
contract SimpleVoting {
    uint256 private constant SECP_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 private constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ======== Errors ========
    error CommitPhaseNotOpen();
    error CommitPhaseClosed();
    error RevealPhaseNotOpen();
    error RevealPhaseClosed();
    error RevealPhaseOngoing();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error InvalidOption();
    error InvalidReveal();
    error InvalidCredentialSignature();
    error InvalidCredentialHash();
    error InvalidSalt();
    error EmptyName();
    error NeedAtLeastTwoOptions();
    error NoCommitment();
    error NotOwner();
    error ZeroCommitment();
    error InvalidSchedule();
    error InvalidIssuer();
    error AlreadyStarted();
    error EmptyOptionLabel();
    error AlreadyFinalized();
    error CredentialRevoked();
    error CredentialAlreadyRevoked();
    error CredentialNotRevoked();

    // ======== Events ========
    event Committed(bytes32 indexed commitment, uint256 timestamp);
    event Voted(uint8 indexed option, uint256 timestamp);
    event Finalized(uint256[] tally, uint256 timestamp);
    event CredentialRevokedEvent(bytes32 indexed credentialHash, uint256 timestamp);
    event CredentialRestoredEvent(bytes32 indexed credentialHash, uint256 timestamp);
    event OptionAdded(uint256 indexed optionIndex, string label);
    event NameUpdated(string name);

    // ======== State ========
    address public immutable owner;        // contract administrator
    address public immutable issuer;       // authority that signs credentials
    string public name;                    // proposal label
    string[] private _options;             // voting options
    uint256 public immutable startAt;      // commit window start (unix)
    uint256 public immutable commitEndAt;  // commit window end (unix)
    uint256 public immutable endAt;        // reveal window end (unix)
    uint256[] private _tally;              // votes per option
    uint256 public immutable issuerPubKeyX;
    uint256 public immutable issuerPubKeyY;

    enum Phase { NotStarted, Commit, Reveal, Ended }

    struct Ballot {
        bytes32 commitment;
        bool revealed;
    }

    struct BlindSignature {
        uint256 s;
        uint256 fx;
        uint256 fy;
    }

    struct ElectionMetadata {
        string name;
        address owner;
        address issuer;
        uint256 startAt;
        uint256 commitEndAt;
        uint256 endAt;
        Phase phase;
        bool finalized;
        uint256 optionCount;
        uint256 totalVotes;
    }

    mapping(bytes32 => Ballot) private _ballots; // credential hash => ballot
    mapping(bytes32 => bool) private _revoked;    // credential hash => revoked flag

    bool public finalized;
    uint256 public constant VERSION = 1;

    constructor(
        string memory _name,
        string[] memory optionLabels,
        uint256 _startAt,
        uint256 _commitEndAt,
        uint256 _endAt,
        address _issuer,
        uint256 _issuerPubKeyX,
        uint256 _issuerPubKeyY
    ) {
        if (bytes(_name).length == 0) revert EmptyName();
        if (optionLabels.length < 2) revert NeedAtLeastTwoOptions();
        if (_startAt == 0 || _commitEndAt <= _startAt || _endAt <= _commitEndAt) revert InvalidSchedule();
        if (_issuer == address(0)) revert InvalidIssuer();
        if (_issuerPubKeyX == 0 || _issuerPubKeyY == 0) revert InvalidIssuer();
        if (!EllipticCurve.isOnCurve(_issuerPubKeyX, _issuerPubKeyY, 0, 7, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F)) revert InvalidIssuer();

        owner = msg.sender;
        issuer = _issuer;
        name = _name;
        startAt = _startAt;
        commitEndAt = _commitEndAt;
        endAt = _endAt;
        _options = optionLabels;
        _tally = new uint256[](optionLabels.length);
        issuerPubKeyX = _issuerPubKeyX;
        issuerPubKeyY = _issuerPubKeyY;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Register a vote commitment during the commit window.
    /// @param credentialHash Blind credential hash representing the voter.
    /// @param commitment Hash computed via keccak256(credentialHash, optionIndex, salt).
    /// @param signature Signature issued by the credential authority over credentialHash.
    function commitVote(bytes32 credentialHash, bytes32 commitment, BlindSignature calldata signature) external {
        uint256 t = _enforceCommitPhase();
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (_revoked[credentialHash]) revert CredentialRevoked();

        Ballot storage ballot = _ballots[credentialHash];
        if (ballot.commitment != bytes32(0)) revert AlreadyCommitted();
        if (!_verifyBlindSignature(credentialHash, signature)) revert InvalidCredentialSignature();

        ballot.commitment = commitment;
        emit Committed(commitment, t);
    }

    /// @notice Reveal a previously committed vote and tally it to the selected option.
    /// @param credentialHash Blind credential associated with the commitment.
    /// @param optionIndex Index of the chosen option.
    /// @param salt Random salt used at commit time.
    function revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt) external {
        uint256 t = _enforceRevealPhase();
        if (optionIndex >= _options.length) revert InvalidOption();
        if (salt == bytes32(0)) revert InvalidSalt();

        Ballot storage ballot = _ballots[credentialHash];
        bytes32 commitment = ballot.commitment;
        if (commitment == bytes32(0)) revert NoCommitment();
        if (ballot.revealed) revert AlreadyRevealed();

        bytes32 computed = keccak256(abi.encodePacked(credentialHash, optionIndex, salt));
        if (computed != commitment) revert InvalidReveal();

        ballot.revealed = true;
        _tally[optionIndex] += 1;
        emit Voted(optionIndex, t);
    }

    /// @notice Emit the final tally event once the reveal window closes.
    function finalize() external {
        if (block.timestamp <= endAt) revert RevealPhaseOngoing();
        if (finalized) revert AlreadyFinalized();

        finalized = true;
        emit Finalized(_tally, block.timestamp);
    }

    /// @notice Revoke a credential that has not committed yet.
    function revokeCredential(bytes32 credentialHash) external onlyOwner {
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (_revoked[credentialHash]) revert CredentialAlreadyRevoked();
        Ballot storage ballot = _ballots[credentialHash];
        if (ballot.commitment != bytes32(0)) revert AlreadyCommitted();

        _revoked[credentialHash] = true;
        emit CredentialRevokedEvent(credentialHash, block.timestamp);
    }

    /// @notice Restore a credential that was revoked by mistake.
    function restoreCredential(bytes32 credentialHash) external onlyOwner {
        if (!_revoked[credentialHash]) revert CredentialNotRevoked();
        delete _revoked[credentialHash];
        emit CredentialRestoredEvent(credentialHash, block.timestamp);
    }

    // ======== Helpers ========

    function _credentialMessage(bytes32 credentialHash) internal pure returns (bytes memory) {
        return abi.encodePacked("SimpleVoting:", credentialHash);
    }

    function _computeChallenge(bytes32 credentialHash) internal pure returns (uint256) {
        uint256 h = uint256(keccak256(_credentialMessage(credentialHash)));
        return h % SECP_N;
    }

    function _verifyBlindSignature(bytes32 credentialHash, BlindSignature memory signature) internal view returns (bool) {
        if (signature.s == 0 || signature.fx == 0 || signature.fy == 0) {
            return false;
        }
        if (!EllipticCurve.isOnCurve(signature.fx, signature.fy, 0, 7, SECP_P)) {
            return false;
        }

        uint256 rx = signature.fx % SECP_N;
        if (rx == 0) {
            return false;
        }

        uint256 challenge = _computeChallenge(credentialHash);
        if (challenge == 0) {
            return false;
        }

        uint256 scalar = mulmod(rx, challenge, SECP_N);
        (uint256 lhsX, uint256 lhsY) = Secp256k1.mulG(signature.s % SECP_N);
        (uint256 rhsXOffset, uint256 rhsYOffset) = Secp256k1.multiply(scalar, issuerPubKeyX, issuerPubKeyY);
        (uint256 rhsX, uint256 rhsY) = Secp256k1.add(signature.fx, signature.fy, rhsXOffset, rhsYOffset);

        return lhsX == rhsX && lhsY == rhsY;
    }

    function _enforceCommitPhase() private view returns (uint256 t) {
        t = block.timestamp;
        if (t < startAt) revert CommitPhaseNotOpen();
        if (t > commitEndAt) revert CommitPhaseClosed();
    }

    function _enforceRevealPhase() private view returns (uint256 t) {
        t = block.timestamp;
        if (t <= commitEndAt) revert RevealPhaseNotOpen();
        if (t > endAt) revert RevealPhaseClosed();
    }

    function _enforceBeforeStart() private view {
        if (block.timestamp >= startAt) revert AlreadyStarted();
    }

    // ======== Views ========

    function currentPhase() public view returns (Phase) {
        uint256 t = block.timestamp;
        if (t < startAt) return Phase.NotStarted;
        if (t <= commitEndAt) return Phase.Commit;
        if (t <= endAt) return Phase.Reveal;
        return Phase.Ended;
    }

    function isOpen() public view returns (bool) {
        Phase phase = currentPhase();
        return phase == Phase.Commit || phase == Phase.Reveal;
    }

    function isCommitPhase() public view returns (bool) {
        return currentPhase() == Phase.Commit;
    }

    function isRevealPhase() public view returns (bool) {
        return currentPhase() == Phase.Reveal;
    }

    function options() external view returns (string[] memory) {
        return _copyOptions();
    }

    function tally() external view returns (uint256[] memory) {
        return _copyTally();
    }

    function optionCount() external view returns (uint256) {
        return _options.length;
    }

    function getOption(uint256 index) external view returns (string memory label, uint256 votes) {
        if (index >= _options.length) revert InvalidOption();
        label = _options[index];
        votes = _tally[index];
    }

    function metadata() external view returns (ElectionMetadata memory summary) {
        summary = ElectionMetadata({
            name: name,
            owner: owner,
            issuer: issuer,
            startAt: startAt,
            commitEndAt: commitEndAt,
            endAt: endAt,
            phase: currentPhase(),
            finalized: finalized,
            optionCount: _options.length,
            totalVotes: totalVotes()
        });
    }

    function optionDetails() external view returns (string[] memory labels, uint256[] memory counts) {
        labels = _copyOptions();
        counts = _copyTally();
    }

    function issuerPublicKey() external view returns (uint256 x, uint256 y) {
        return (issuerPubKeyX, issuerPubKeyY);
    }

    function ballotStatus(bytes32 credentialHash) external view returns (bytes32 commitment, bool revealed, bool revoked) {
        Ballot storage ballot = _ballots[credentialHash];
        commitment = ballot.commitment;
        revealed = ballot.revealed;
        revoked = _revoked[credentialHash];
    }

    function isCredentialRevoked(bytes32 credentialHash) external view returns (bool) {
        return _revoked[credentialHash];
    }

    function verifyCredential(bytes32 credentialHash, BlindSignature calldata signature) external view returns (bool) {
        if (credentialHash == bytes32(0)) return false;
        if (_revoked[credentialHash]) return false;
        return _verifyBlindSignature(credentialHash, signature);
    }

    function credentialDigest(bytes32 credentialHash) external pure returns (bytes32) {
        return keccak256(_credentialMessage(credentialHash));
    }

    function computeCommitment(bytes32 credentialHash, uint8 optionIndex, bytes32 salt) external pure returns (bytes32) {
        if (salt == bytes32(0)) revert InvalidSalt();
        return keccak256(abi.encodePacked(credentialHash, optionIndex, salt));
    }

    function ballotOf(bytes32 credentialHash) external view returns (bytes32 commitment, bool revealed) {
        Ballot storage ballot = _ballots[credentialHash];
        return (ballot.commitment, ballot.revealed);
    }

    function totalVotes() public view returns (uint256 total) {
        uint256 len = _tally.length;
        for (uint256 i = 0; i < len; i++) total += _tally[i];
    }

    function leadingOption() public view returns (uint256 index, uint256 count, bool tie) {
        uint256 maxCount;
        uint256 maxIndex;
        bool hasTie;
        for (uint256 i = 0; i < _tally.length; i++) {
            uint256 c = _tally[i];
            if (c > maxCount) {
                maxCount = c;
                maxIndex = i;
                hasTie = false;
            } else if (c == maxCount && c != 0) {
                hasTie = true;
            }
        }
        return (maxIndex, maxCount, hasTie);
    }

    // ======== Admin (before start) ========

    function setName(string calldata newName) external onlyOwner {
        _enforceBeforeStart();
        if (bytes(newName).length == 0) revert EmptyName();
        name = newName;
        emit NameUpdated(newName);
    }

    function addOption(string calldata label) external onlyOwner {
        _enforceBeforeStart();
        if (bytes(label).length == 0) revert EmptyOptionLabel();
        _options.push(label);
        _tally.push(0);
        emit OptionAdded(_options.length - 1, label);
    }

    // ======== Internals ========

    function _copyOptions() private view returns (string[] memory labels) {
        uint256 len = _options.length;
        labels = new string[](len);
        for (uint256 i = 0; i < len; i++) {
            labels[i] = _options[i];
        }
    }

    function _copyTally() private view returns (uint256[] memory counts) {
        uint256 len = _tally.length;
        counts = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            counts[i] = _tally[i];
        }
    }
}
