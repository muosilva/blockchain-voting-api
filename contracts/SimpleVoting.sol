// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Vota??uo Commit-Reveal On-chain
/// @notice Uma pauta por contrato. Cada endere??o registra um compromisso e revela
///         o voto posteriormente dentro da janela definida.
contract SimpleVoting {
    // Erros
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

    // Eventos
    event Committed(bytes32 indexed commitment, uint256 timestamp);
    event Voted(uint8 indexed option, uint256 timestamp);
    event Finalized(uint256[] tally, uint256 timestamp);

    // Estado
    address public immutable owner;
    address public immutable issuer;          // autoridade que assina as credenciais
    string public name;                 // nome da pauta
    string[] private _options;          // r??tulos das op????es
    uint256 public immutable startAt;   // in??cio do per??odo de commit (unix)
    uint256 public immutable commitEndAt; // fim do per??odo de commit (unix)
    uint256 public immutable endAt;     // fim do per??odo de reveal (unix)
    uint256[] private _tally;           // contagem por op??uo

    enum Phase { NotStarted, Commit, Reveal, Ended }

    struct Ballot {
        bytes32 commitment;
        bool revealed;
    }

    mapping(bytes32 => Ballot) private _ballots; // credential hash => voto
    bool public finalized;

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
        name = _name;
        startAt = _startAt;
        commitEndAt = _commitEndAt;
        endAt = _endAt;
        _options = optionLabels;
        _tally = new uint256[](optionLabels.length);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    /// @notice Registra o compromisso hashado de um voto durante a fase de commit.
    /// @param credentialHash Token opaco representando o eleitor (resultado do blind signature).
    /// @param commitment Hash calculado via `keccak256(credentialHash, optionIndex, salt)`.
    /// @param signature Assinatura emitida pela autoridade sobre `credentialHash`.
    function commitVote(bytes32 credentialHash, bytes32 commitment, bytes calldata signature) external {
        uint256 t = _enforceCommitPhase();
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();
        if (commitment == bytes32(0)) revert ZeroCommitment();

        Ballot storage ballot = _ballots[credentialHash];
        if (ballot.commitment != bytes32(0)) revert AlreadyCommitted();

        bytes32 digest = _credentialSignDigest(credentialHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != issuer) revert InvalidCredentialSignature();

        ballot.commitment = commitment;
        emit Committed(commitment, t);
    }

    /// @notice Revela o voto previamente comprometido, contabilizando a op??uo correspondente.
    /// @param optionIndex ??ndice da op??uo na qual o endere??o deseja votar.
    /// @param salt Valor aleat??rio usado na fase de commit.
    /// @param credentialHash Token opaco associado ao compromisso.
    function revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt) external {
        uint256 t = _enforceRevealPhase();
        if (optionIndex >= _options.length) revert InvalidOption();

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

    function finalize() external {
        if (block.timestamp <= endAt) revert RevealPhaseOngoing();
        if (finalized) revert AlreadyFinalized();

        finalized = true;
        emit Finalized(_tally, block.timestamp);
    }

    // ======== Helpers ========

    function _credentialSignDigest(bytes32 credentialHash) internal view returns (bytes32) {
        bytes32 msgHash = keccak256(
            abi.encodePacked(
                "SimpleVoting:",
                address(this),
                block.chainid,
                credentialHash
            )
        );
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

    // VIEWS
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
        return _options;
    }

    function tally() external view returns (uint256[] memory) {
        return _tally;
    }

    function ballotOf(bytes32 credentialHash) external view returns (bytes32 commitment, bool revealed) {
        Ballot storage ballot = _ballots[credentialHash];
        return (ballot.commitment, ballot.revealed);
    }

    function totalVotes() public view returns (uint256 total) {
        for (uint256 i = 0; i < _tally.length; i++) total += _tally[i];
    }

    function leadingOption() public view returns (uint256 index, uint256 count, bool tie) {
        uint256 maxCount; uint256 maxIndex; bool hasTie;
        for (uint256 i = 0; i < _tally.length; i++) {
            uint256 c = _tally[i];
            if (c > maxCount) { maxCount = c; maxIndex = i; hasTie = false; }
            else if (c == maxCount && c != 0) { hasTie = true; }
        }
        return (maxIndex, maxCount, hasTie);
    }

    // Admin (opcional): apenas antes do in??cio
    function setName(string calldata newName) external onlyOwner {
        _enforceBeforeStart();
        if (bytes(newName).length == 0) revert EmptyName();
        name = newName;
    }

    function addOption(string calldata label) external onlyOwner {
        _enforceBeforeStart();
        if (bytes(label).length == 0) revert EmptyOptionLabel();
        _options.push(label);
        _tally.push(0);
    }
}
