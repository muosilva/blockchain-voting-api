// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Simple PoS Stake Token (ERC-721)
/// @notice Utility token used to gate voting rights. Each NFT represents one vote weight.
contract StakeToken is ERC721, ERC721Enumerable, Ownable {
    error InvalidRecipient();
    // ======== Events ========
    event BaseTokenURIUpdated(string newBaseURI);

    // ======== State ========
    uint256 private _tokenIdTracker;
    string private _baseTokenURI;

    constructor(string memory name_, string memory symbol_, string memory baseTokenURI_)
        ERC721(name_, symbol_)
        Ownable(msg.sender)
    {
        _baseTokenURI = baseTokenURI_;
        emit BaseTokenURIUpdated(baseTokenURI_);
    }

    // ======== Minting ========

    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        if (to == address(0)) revert InvalidRecipient();
        tokenId = ++_tokenIdTracker;
        _safeMint(to, tokenId);
    }

    function batchMint(address[] calldata recipients) external onlyOwner {
        uint256 length = recipients.length;
        for (uint256 i = 0; i < length; ++i) {
            address recipient = recipients[i];
            if (recipient == address(0)) revert InvalidRecipient();
            ++_tokenIdTracker;
            _safeMint(recipient, _tokenIdTracker);
        }
    }

    // ======== Owner actions ========

    function setBaseTokenURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseTokenURIUpdated(newBaseURI);
    }

    // ======== Views ========

    function nextTokenId() external view returns (uint256) {
        return _tokenIdTracker + 1;
    }

    function tokensOfOwner(address owner_) external view returns (uint256[] memory tokens) {
        uint256 balance = balanceOf(owner_);
        tokens = new uint256[](balance);
        for (uint256 i = 0; i < balance; ++i) {
            tokens[i] = tokenOfOwnerByIndex(owner_, i);
        }
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721, ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 amount) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }
}
