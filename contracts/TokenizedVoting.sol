// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SimpleVoting} from "./SimpleVoting.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title Tokenized Voting (ERC-721) with commit-reveal logic
/// @notice Each eligible voter receives a transferable ERC-721 that grants the right to cast a ballot.
contract TokenizedVoting is SimpleVoting, ERC721 {
    // ======== Errors ========
    error InvalidRecipient();
    error TokenAlreadyUsed(uint256 tokenId);
    error TokenNotOwned(uint256 tokenId, address expectedOwner, address caller);
    error UseCommitWithToken();

    // ======== Events ========
    event VoteTokenMinted(address indexed to, uint256 indexed tokenId);
    event VoteTokenUsed(uint256 indexed tokenId, bytes32 indexed credentialHash, address indexed caller);
    event BaseTokenURISet(string uri);

    // ======== State ========
    uint256 private _tokenCounter;
    string private _baseTokenURI;
    mapping(uint256 => bool) private _tokenUsed;

    constructor(
        string memory _name,
        string[] memory optionLabels,
        uint256 _startAt,
        uint256 _commitEndAt,
        uint256 _endAt,
        address _issuer,
        string memory baseTokenURI_
    )
        SimpleVoting(_name, optionLabels, _startAt, _commitEndAt, _endAt, _issuer)
        ERC721("Voting Ticket", "VTK")
    {
        _baseTokenURI = baseTokenURI_;
        emit BaseTokenURISet(baseTokenURI_);
    }

    // ======== Public getters ========

    function nextTokenId() external view returns (uint256) {
        return _tokenCounter + 1;
    }

    function tokenUsed(uint256 tokenId) external view returns (bool) {
        return _tokenUsed[tokenId];
    }

    function baseTokenURI() external view returns (string memory) {
        return _baseTokenURI;
    }

    // ======== Owner actions ========

    function setBaseTokenURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseTokenURISet(newBaseURI);
    }

    function mintVoteToken(address to) public onlyOwner returns (uint256 tokenId) {
        if (to == address(0)) revert InvalidRecipient();
        tokenId = ++_tokenCounter;
        _safeMint(to, tokenId);
        emit VoteTokenMinted(to, tokenId);
    }

    function mintVoteTokens(address[] calldata recipients) external onlyOwner {
        uint256 len = recipients.length;
        for (uint256 i = 0; i < len; ++i) {
            mintVoteToken(recipients[i]);
        }
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
        address owner = ownerOf(tokenId);
        if (owner != msg.sender) {
            bool approvedForAll = isApprovedForAll(owner, msg.sender);
            address approved = getApproved(tokenId);
            if (!approvedForAll && approved != msg.sender) {
                revert TokenNotOwned(tokenId, owner, msg.sender);
            }
        }
        if (_tokenUsed[tokenId]) revert TokenAlreadyUsed(tokenId);

        super.commitVote(credentialHash, commitment, signature);
        _tokenUsed[tokenId] = true;
        emit VoteTokenUsed(tokenId, credentialHash, msg.sender);
    }

    // ======== Internals ========

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
