// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IStakeToken {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title TokenizedVoting
/// @notice Commit-reveal voting contract gated by ERC721 stake tokens.
contract TokenizedVoting {
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
    error InvalidStakeToken();
    error TokenNotOwned(uint256 tokenId, address expectedOwner, address actualOwner);
    error TokenAlreadyUsed(uint256 tokenId);
    error UseCommitWithToken();

    // ======== Events ========
    event Committed(bytes32 indexed commitment, uint256 timestamp);
    event Voted(uint8 indexed option, uint256 timestamp);
    event Finalized(uint256[] tally, uint256 timestamp);
    event CredentialRevokedEvent(bytes32 indexed credentialHash, uint256 timestamp);
    event CredentialRestoredEvent(bytes32 indexed credentialHash, uint256 timestamp);
    event OptionAdded(uint256 indexed optionIndex, string label);
    event NameUpdated(string name);
    event StakeTokenUsed(uint256 indexed tokenId, address indexed voter);

    // ======== State ========
    address public immutable owner;
    address public immutable issuer;
    IStakeToken public immutable stakeToken;
    string public name;
    string[] private _options;
    uint256 public immutable startAt;
    uint256 public immutable commitEndAt;
    uint256 public immutable endAt;
    uint256[] private _tally;

    enum Phase { NotStarted, Commit, Reveal, Ended }

    struct Ballot {
        bytes32 commitment;
        bool revealed;
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

    mapping(bytes32 => Ballot) private _ballots;
    mapping(bytes32 => bool) private _revoked;
    mapping(uint256 => bool) private _tokenUsed;

    bool public finalized;
    uint256 public constant VERSION = 1;

    constructor(
        string memory _name,
        string[] memory optionLabels,
        uint256 _startAt,
        uint256 _commitEndAt,
        uint256 _endAt,
        address _issuer,
        address _stakeToken
    ) {
        if (bytes(_name).length == 0) revert EmptyName();
        if (optionLabels.length < 2) revert NeedAtLeastTwoOptions();
        if (_startAt == 0 || _commitEndAt <= _startAt || _endAt <= _commitEndAt) revert InvalidSchedule();
        if (_issuer == address(0)) revert InvalidIssuer();
        if (_stakeToken == address(0)) revert InvalidStakeToken();

        owner = msg.sender;
        issuer = _issuer;
        stakeToken = IStakeToken(_stakeToken);
        name = _name;
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

    function stakeTokenAddress() external view returns (address) {
        return address(stakeToken);
    }

    function tokenUsed(uint256 tokenId) external view returns (bool) {
        return _tokenUsed[tokenId];
    }

    function commitVote(bytes32, bytes32, bytes calldata) external pure {
        revert UseCommitWithToken();
    }

    function commitVoteWithToken(
        uint256 tokenId,
        bytes32 credentialHash,
        bytes32 commitment,
        bytes calldata signature
    ) external {
        uint256 t = _enforceCommitPhase();
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (_revoked[credentialHash]) revert CredentialRevoked();

        address ownerOfToken = stakeToken.ownerOf(tokenId);
        if (ownerOfToken != msg.sender) revert TokenNotOwned(tokenId, ownerOfToken, msg.sender);
        if (_tokenUsed[tokenId]) revert TokenAlreadyUsed(tokenId);

        Ballot storage ballot = _ballots[credentialHash];
        if (ballot.commitment != bytes32(0)) revert AlreadyCommitted();

        bytes32 digest = _credentialSignDigest(credentialHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != issuer) revert InvalidCredentialSignature();

        _tokenUsed[tokenId] = true;
        ballot.commitment = commitment;
        ballot.committer = msg.sender;
        emit StakeTokenUsed(tokenId, msg.sender);
        emit Committed(commitment, t);
    }

    function revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt) external {
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
        _tally[optionIndex] += 1;
        emit Voted(optionIndex, t);
    }

    function finalize() external {
        _enforceEndedPhase();
        if (finalized) revert AlreadyFinalized();
        finalized = true;
        emit Finalized(_copyTally(), block.timestamp);
    }

    function revokeCredential(bytes32 credentialHash) external onlyOwner {
        if (_revoked[credentialHash]) revert CredentialAlreadyRevoked();
        _revoked[credentialHash] = true;
        emit CredentialRevokedEvent(credentialHash, block.timestamp);
    }

    function restoreCredential(bytes32 credentialHash) external onlyOwner {
        if (!_revoked[credentialHash]) revert CredentialNotRevoked();
        _revoked[credentialHash] = false;
        emit CredentialRestoredEvent(credentialHash, block.timestamp);
    }

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

    function currentPhase() public view returns (Phase) {
        if (block.timestamp < startAt) return Phase.NotStarted;
        if (block.timestamp <= commitEndAt) return Phase.Commit;
        if (block.timestamp <= endAt) return Phase.Reveal;
        return Phase.Ended;
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

    function getOption(uint256 index) external view returns (string memory label, uint256 votes) {
        if (index >= _options.length) revert InvalidOption();
        label = _options[index];
        votes = _tally[index];
    }

    function tally() external view returns (uint256[] memory) {
        return _copyTally();
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

    function ballotStatus(bytes32 credentialHash) external view returns (bytes32 commitment, bool revealed, bool revoked, address committer) {
        Ballot storage ballot = _ballots[credentialHash];
        commitment = ballot.commitment;
        revealed = ballot.revealed;
        revoked = _revoked[credentialHash];
        committer = ballot.committer;
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

    function computeCommitment(bytes32 credentialHash, uint8 optionIndex, bytes32 salt, address committer) external pure returns (bytes32) {
        if (salt == bytes32(0)) revert InvalidSalt();
        return keccak256(abi.encodePacked(credentialHash, optionIndex, salt, committer));
    }

    function ballotOf(bytes32 credentialHash) external view returns (bytes32 commitment, bool revealed, address committer) {
        Ballot storage ballot = _ballots[credentialHash];
        return (ballot.commitment, ballot.revealed, ballot.committer);
    }

    function _enforceBeforeStart() internal view {
        if (block.timestamp >= startAt) revert AlreadyStarted();
    }

    function _enforceCommitPhase() internal view returns (uint256 timestamp) {
        if (block.timestamp < startAt) revert CommitPhaseNotOpen();
        if (block.timestamp > commitEndAt) revert CommitPhaseClosed();
        return block.timestamp;
    }

    function _enforceRevealPhase() internal view returns (uint256 timestamp) {
        if (block.timestamp <= commitEndAt) revert RevealPhaseNotOpen();
        if (block.timestamp > endAt) revert RevealPhaseClosed();
        return block.timestamp;
    }

    function _enforceEndedPhase() internal view {
        if (block.timestamp <= endAt) revert RevealPhaseOngoing();
    }

    function _credentialSignDigest(bytes32 credentialHash) internal pure returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encodePacked("SimpleVoting:", credentialHash)));
    }

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
