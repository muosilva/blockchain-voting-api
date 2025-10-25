// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title Commit-Reveal voting contract for permissioned PoS networks
/// @notice One proposal per contract. Each credential commits a vote hash and reveals later within the configured window.
contract SimpleVoting {
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
    error InvalidAuditRoot();
    error AuditSnapshotAlreadySet();

    // ======== Events ========
    event Committed(bytes32 indexed commitment, uint256 timestamp);
    event Voted(uint8 indexed option, uint256 timestamp);
    event Finalized(uint256[] tally, uint256 timestamp);
    event CredentialRevokedEvent(bytes32 indexed credentialHash, uint256 timestamp);
    event CredentialRestoredEvent(bytes32 indexed credentialHash, uint256 timestamp);
    event OptionAdded(uint256 indexed optionIndex, string label);
    event NameUpdated(string name);
    event AuditSnapshotSet(bytes32 indexed root, uint256 timestamp);

    // ======== State ========
    address public immutable owner;        // contract administrator
    address public immutable issuer;       // authority that signs credentials
    string public proposalName;            // proposal label
    string[] private _options;             // voting options
    uint256 public immutable startAt;      // commit window start (unix)
    uint256 public immutable commitEndAt;  // commit window end (unix)
    uint256 public immutable endAt;        // reveal window end (unix)
    uint256[] private _tally;              // votes per option

    enum Phase { NotStarted, Commit, Reveal, Ended }

    struct Ballot {
        bytes32 commitment;
        bool revealed;
        uint96 weight;
        address committer;
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

    mapping(bytes32 => Ballot) internal _ballots; // credential hash => ballot
    mapping(bytes32 => bool) private _revoked;    // credential hash => revoked flag
    bytes32 public auditSnapshotRoot;             // merkle root of commitments at commit close

    bool public finalized;
    uint256 public constant VERSION = 1;

    constructor(
        string memory _name,
        string[] memory optionLabels,
        uint256 _startAt,
        uint256 _commitEndAt,
        uint256 _endAt,
        address _issuer
    ) {
        if (bytes(_name).length == 0) revert EmptyName();
        if (optionLabels.length < 2) revert NeedAtLeastTwoOptions();
        if (_startAt == 0 || _commitEndAt <= _startAt || _endAt <= _commitEndAt) revert InvalidSchedule();
        if (_issuer == address(0)) revert InvalidIssuer();

        owner = msg.sender;
        issuer = _issuer;
        proposalName = _name;
        startAt = _startAt;
        commitEndAt = _commitEndAt;
        endAt = _endAt;
        _options = optionLabels;
        _tally = new uint256[](optionLabels.length);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Register a vote commitment during the commit window.
    /// @param credentialHash Blind credential hash representing the voter.
    /// @param commitment Hash computed via keccak256(credentialHash, optionIndex, salt, committer).
    /// @param signature Signature issued by the credential authority over credentialHash.
    function commitVote(bytes32 credentialHash, bytes32 commitment, bytes calldata signature) public virtual {
        uint256 t = _enforceCommitPhase();
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (_revoked[credentialHash]) revert CredentialRevoked();

        Ballot storage ballot = _ballots[credentialHash];
        if (ballot.commitment != bytes32(0)) revert AlreadyCommitted();

        bytes32 digest = _credentialSignDigest(credentialHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != issuer) revert InvalidCredentialSignature();

        ballot.commitment = commitment;
        ballot.weight = 1;
        ballot.committer = msg.sender;
        emit Committed(commitment, t);
    }

    /// @notice Reveal a previously committed vote and tally it to the selected option.
    /// @param credentialHash Blind credential associated with the commitment.
    /// @param optionIndex Index of the chosen option.
    /// @param salt Random salt used at commit time.
    function revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt) public virtual {
        uint256 t = _enforceRevealPhase();
        if (optionIndex >= _options.length) revert InvalidOption();
        if (salt == bytes32(0)) revert InvalidSalt();

        Ballot storage ballot = _ballots[credentialHash];
        bytes32 commitment = ballot.commitment;
        if (commitment == bytes32(0)) revert NoCommitment();
        if (ballot.revealed) revert AlreadyRevealed();

        bytes32 computed = keccak256(abi.encodePacked(credentialHash, optionIndex, salt, ballot.committer));
        if (computed != commitment) revert InvalidReveal();

        ballot.revealed = true;
        uint96 weight = ballot.weight;
        _tally[optionIndex] += weight == 0 ? 1 : weight;
        emit Voted(optionIndex, t);
    }

    /// @notice Emit the final tally event once the reveal window closes.
    function finalize() external {
        if (block.timestamp <= endAt) revert RevealPhaseOngoing();
        if (finalized) revert AlreadyFinalized();

        finalized = true;
        emit Finalized(_tally, block.timestamp);
    }

    /// @notice Set a Merkle root snapshot of commitments after commit phase closes for audit purposes.
    /// @dev The root should be computed off-chain using pairwise-sorted hashing of commitment leaves (bytes32 commitments).
    ///      This does not reduce privacy: it's a single hash derived from already-public commit events.
    function setAuditSnapshotRoot(bytes32 root) external onlyOwner {
        if (root == bytes32(0)) revert InvalidAuditRoot();
        if (auditSnapshotRoot != bytes32(0)) revert AuditSnapshotAlreadySet();
        // ensure commit phase is closed
        if (block.timestamp <= commitEndAt) revert RevealPhaseNotOpen();
        auditSnapshotRoot = root;
        emit AuditSnapshotSet(root, block.timestamp);
    }

    /// @notice Verify whether a commitment belongs to the stored audit snapshot using a Merkle proof.
    function verifyAuditCommitment(bytes32 commitment, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = auditSnapshotRoot;
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, commitment);
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

    function _credentialSignDigest(bytes32 credentialHash) internal pure returns (bytes32) {
        bytes32 msgHash = keccak256(abi.encodePacked("SimpleVoting:", credentialHash));
        return MessageHashUtils.toEthSignedMessageHash(msgHash);
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
            name: proposalName,
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

    function ballotStatus(bytes32 credentialHash) external view returns (bytes32 commitment, bool revealed, bool revoked) {
        Ballot storage ballot = _ballots[credentialHash];
        commitment = ballot.commitment;
        revealed = ballot.revealed;
        revoked = _revoked[credentialHash];
    }

    function ballotWeight(bytes32 credentialHash) external view returns (uint256) {
        uint96 weight = _ballots[credentialHash].weight;
        return weight == 0 ? 1 : weight;
    }

    function isCredentialRevoked(bytes32 credentialHash) external view returns (bool) {
        return _revoked[credentialHash];
    }

    function verifyCredential(bytes32 credentialHash, bytes calldata signature) external view returns (bool) {
        if (credentialHash == bytes32(0) || signature.length == 0) return false;
        if (_revoked[credentialHash]) return false;

        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(_credentialSignDigest(credentialHash), signature);
        return err == ECDSA.RecoverError.NoError && recovered == issuer;
    }

    function credentialDigest(bytes32 credentialHash) external pure returns (bytes32) {
        return _credentialSignDigest(credentialHash);
    }

    function computeCommitment(bytes32 credentialHash, uint8 optionIndex, bytes32 salt, address committer)
        external
        pure
        returns (bytes32)
    {
        if (salt == bytes32(0)) revert InvalidSalt();
        return keccak256(abi.encodePacked(credentialHash, optionIndex, salt, committer));
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
        proposalName = newName;
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
