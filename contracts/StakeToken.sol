// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title StakeToken
/// @notice Simple ERC721 token used to gate commit actions in TokenizedVoting.
contract StakeToken is ERC721Enumerable, Ownable {
    error InvalidRecipient();

    event BaseTokenURIUpdated(string newBaseURI);

    uint256 private _nextTokenId = 1;
    string private _baseTokenURI;

    constructor(string memory name_, string memory symbol_, string memory baseTokenURI_)
        ERC721(name_, symbol_)
        Ownable(msg.sender)
    {
        _baseTokenURI = baseTokenURI_;
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    function setBaseTokenURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseTokenURIUpdated(newBaseURI);
    }

    function mint(address to) public onlyOwner returns (uint256 tokenId) {
        if (to == address(0)) revert InvalidRecipient();
        tokenId = _nextTokenId;
        _nextTokenId += 1;
        _safeMint(to, tokenId);
    }

    function batchMint(address[] calldata recipients) external onlyOwner {
        uint256 length = recipients.length;
        for (uint256 i = 0; i < length; i++) {
            mint(recipients[i]);
        }
    }

    function tokensOfOwner(address owner) external view returns (uint256[] memory tokens) {
        uint256 balance = balanceOf(owner);
        tokens = new uint256[](balance);
        for (uint256 i = 0; i < balance; i++) {
            tokens[i] = tokenOfOwnerByIndex(owner, i);
        }
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Enumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
