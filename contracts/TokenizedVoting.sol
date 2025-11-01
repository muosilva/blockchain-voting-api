// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SimpleVoting} from "./SimpleVoting.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title Tokenized Voting gated by an external PoS stake token
/// @notice Holders of the configured ERC-721 stake token can commit a vote once per tokenId.
contract TokenizedVoting is SimpleVoting {
    // ======== Errors ========
    error InvalidStakeToken();
    error TokenAlreadyUsed(uint256 tokenId);
    error TokenNotOwned(uint256 tokenId, address expectedOwner, address caller);
    error UseCommitWithToken();

    // ======== Events ========
    event StakeTokenUsed(uint256 indexed tokenId, bytes32 indexed credentialHash, address indexed caller);

    // ======== State ========
    IERC721 public immutable stakeToken;
    mapping(uint256 => bool) private _tokenUsed;

    constructor(
        string memory _name,
        string[] memory optionLabels,
        uint256 _startAt,
        uint256 _commitEndAt,
        uint256 _endAt,
        address _issuer,
        IERC721 stakeToken_
    ) SimpleVoting(_name, optionLabels, _startAt, _commitEndAt, _endAt, _issuer) {
        address tokenAddr = address(stakeToken_);
        if (tokenAddr == address(0)) revert InvalidStakeToken();
        stakeToken = stakeToken_;
    }

    // ======== Public getters ========

    function stakeTokenAddress() external view returns (address) {
        return address(stakeToken);
    }

    function tokenUsed(uint256 tokenId) external view returns (bool) {
        return _tokenUsed[tokenId];
    }

    // ======== Voting overrides ========

    function commitVote(bytes32, bytes32, bytes calldata) public pure override {
        revert UseCommitWithToken();
    }

    function commitVoteWithToken(
        uint256 tokenId,
        bytes32 credentialHash,
        bytes32 commitment,
        bytes calldata signature
    ) external {
        address owner = stakeToken.ownerOf(tokenId);
        if (owner != msg.sender) {
            bool approvedForAll = stakeToken.isApprovedForAll(owner, msg.sender);
            address approved = stakeToken.getApproved(tokenId);
            if (!approvedForAll && approved != msg.sender) {
                revert TokenNotOwned(tokenId, owner, msg.sender);
            }
        }
        if (_tokenUsed[tokenId]) revert TokenAlreadyUsed(tokenId);

        super.commitVote(credentialHash, commitment, signature);
        _tokenUsed[tokenId] = true;
        emit StakeTokenUsed(tokenId, credentialHash, msg.sender);
    }
}
