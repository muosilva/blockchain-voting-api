// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title Votação Commit-Reveal On-chain
/// @notice Uma pauta por contrato. Cada endereço registra um compromisso e revela
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

    // Eventos
    event Committed(bytes32 indexed commitment, uint256 timestamp);
    event Voted(uint8 indexed option, uint256 timestamp);
    event Finalized(uint256[] tally, uint256 timestamp);

    // Estado
    address public immutable owner;
    address public immutable issuer;          // autoridade que assina as credenciais
    string public name;                 // nome da pauta
    string[] private _options;          // rótulos das opções
    uint256 public immutable startAt;   // início do período de commit (unix)
    uint256 public immutable commitEndAt; // fim do período de commit (unix)
    uint256 public immutable endAt;     // fim do período de reveal (unix)
    uint256[] private _tally;           // contagem por opção

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
        require(_startAt > 0, "bad start");
        require(_commitEndAt > _startAt, "bad commit window");
        require(_endAt > _commitEndAt, "bad reveal window");
        require(_issuer != address(0), "issuer");

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
        uint256 t = block.timestamp;
        if (t < startAt) revert CommitPhaseNotOpen();
        if (t > commitEndAt) revert CommitPhaseClosed();
        if (credentialHash == bytes32(0)) revert InvalidCredentialHash();

        Ballot storage ballot = _ballots[credentialHash];
        if (ballot.commitment != bytes32(0)) revert AlreadyCommitted();

        bytes32 digest = _credentialSignDigest(credentialHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != issuer) revert InvalidCredentialSignature();

        ballot.commitment = commitment;
        emit Committed(commitment, t);
    }

    /// @notice Revela o voto previamente comprometido, contabilizando a opção correspondente.
    /// @param optionIndex Índice da opção na qual o endereço deseja votar.
    /// @param salt Valor aleatório usado na fase de commit.
    /// @param credentialHash Token opaco associado ao compromisso.
    function revealVote(bytes32 credentialHash, uint8 optionIndex, bytes32 salt) external {
        uint256 t = block.timestamp;
        if (t <= commitEndAt) revert RevealPhaseNotOpen();
        if (t > endAt) revert RevealPhaseClosed();
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
        if (!finalized) {
            finalized = true;
            emit Finalized(_tally, block.timestamp);
        }
    }

    // ======== Helpers de segurança / domínio ========

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

    // VIEWS
    function isOpen() public view returns (bool) {
        uint256 t = block.timestamp;
        return t >= startAt && t <= endAt;
    }

    function isCommitPhase() public view returns (bool) {
        uint256 t = block.timestamp;
        return t >= startAt && t <= commitEndAt;
    }

    function isRevealPhase() public view returns (bool) {
        uint256 t = block.timestamp;
        return t > commitEndAt && t <= endAt;
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

    // Admin (opcional): apenas antes do início
    function setName(string calldata newName) external onlyOwner {
        require(block.timestamp < startAt, "started");
        if (bytes(newName).length == 0) revert EmptyName();
        name = newName;
    }

    function addOption(string calldata label) external onlyOwner {
        require(block.timestamp < startAt, "started");
        _options.push(label);
        _tally.push(0);
    }
}
