// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Votação Simples com Pauta e Janela de Tempo
/// @notice Uma pauta por contrato. Cada endereço vota 1x em uma das opções.
contract SimpleVoting {
    // Erros
    error AlreadyVoted();
    error VotingNotOpen();
    error VotingClosed();
    error InvalidOption();
    error EmptyName();
    error NeedAtLeastTwoOptions();
    error NotOwner();

    // Eventos
    event Voted(address indexed voter, uint8 indexed option, uint256 timestamp);
    event Finalized(uint256[] tally, uint256 timestamp);

    // Estado
    address public immutable owner;
    string public name;                 // nome da pauta
    string[] private _options;          // rótulos das opções
    uint256 public immutable startAt;   // início (unix)
    uint256 public immutable endAt;     // fim (unix)
    uint256[] private _tally;           // contagem por opção
    mapping(address => bool) public hasVoted;
    bool public finalized;

    constructor(
        string memory _name,
        string[] memory options,
        uint256 _startAt,
        uint256 _endAt
    ) {
        if (bytes(_name).length == 0) revert EmptyName();
        if (options.length < 2) revert NeedAtLeastTwoOptions();
        require(_endAt > _startAt && _startAt > 0, "bad window");

        owner = msg.sender;
        name = _name;
        startAt = _startAt;
        endAt = _endAt;
        _options = options;
        _tally = new uint256[](options.length);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    function vote(uint8 optionIndex) external {
        uint256 t = block.timestamp;
        if (t < startAt) revert VotingNotOpen();
        if (t > endAt) revert VotingClosed();
        if (hasVoted[msg.sender]) revert AlreadyVoted();
        if (optionIndex >= _options.length) revert InvalidOption();

        hasVoted[msg.sender] = true;
        _tally[optionIndex] += 1;
        emit Voted(msg.sender, optionIndex, t);
    }

    function finalize() external {
        if (block.timestamp <= endAt) revert VotingClosed(); // ainda aberta
        if (!finalized) {
            finalized = true;
            emit Finalized(_tally, block.timestamp);
        }
    }

    // VIEWS
    function isOpen() public view returns (bool) {
        uint256 t = block.timestamp;
        return t >= startAt && t <= endAt;
    }

    function options() external view returns (string[] memory) {
        return _options;
    }

    function tally() external view returns (uint256[] memory) {
        return _tally;
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
