// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title CrivacyKycNFT — soulbound "KYC verified" showcase token
/// @notice FHE-era soulbound KYC showcase token (crivacy-kyc-v2 v1.1.0).
///         Operator-minted, customer-held, non-transferable (soulbound),
///         Enhanced-only, carrying an inline on-chain SVG image as its
///         tokenURI (Pattern B — same approach as Loot / Nouns). No sensitive
///         KYC data lives here; the NFT is a personal "I am verified" artefact
///         bound to the customer's credential lifecycle (cascade-burned when
///         the credential is revoked).
contract CrivacyKycNFT is ERC721 {
    address public operator; // Crivacy issuer
    address public registry; // CrivacyKYC contract (cascade-burn authority)

    uint256 private _nextId = 1;

    struct Meta {
        address customer;
        uint64 issuedAt;
        string serialNumber;
        string displayName;
        string uri; // data:application/json;base64,... (embeds the SVG image)
    }

    mapping(uint256 => Meta) private _meta;
    /// One soulbound token per customer; 0 means none.
    mapping(address => uint256) public tokenOfCustomer;

    event Minted(address indexed customer, uint256 indexed tokenId, string serialNumber);
    event Burned(address indexed customer, uint256 indexed tokenId);
    event RegistryLinked(address indexed registry);
    event OperatorChanged(address indexed newOperator);

    modifier onlyAuthorized() {
        require(msg.sender == operator || msg.sender == registry, "CrivacyKycNFT: not authorized");
        _;
    }

    constructor(address operator_) ERC721("Crivacy KYC Pass", "CRIVKYC") {
        require(operator_ != address(0), "CrivacyKycNFT: zero operator");
        operator = operator_;
    }

    function setRegistry(address registry_) external {
        require(msg.sender == operator, "CrivacyKycNFT: not operator");
        registry = registry_;
        emit RegistryLinked(registry_);
    }

    function setOperator(address newOperator) external {
        require(msg.sender == operator, "CrivacyKycNFT: not operator");
        require(newOperator != address(0), "CrivacyKycNFT: zero operator");
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    /// @notice Mint a soulbound KYC pass. The Enhanced-only invariant is
    ///         enforced by the caller (operator/registry mints only for
    ///         Enhanced credentials). One token per customer.
    function mint(
        address customer,
        string calldata serialNumber,
        string calldata displayName,
        string calldata uri
    ) external onlyAuthorized returns (uint256 tokenId) {
        require(customer != address(0), "CrivacyKycNFT: zero customer");
        require(tokenOfCustomer[customer] == 0, "CrivacyKycNFT: already minted");
        require(bytes(serialNumber).length > 0, "CrivacyKycNFT: empty serial");
        require(bytes(displayName).length > 0, "CrivacyKycNFT: empty name");
        require(bytes(uri).length > 0, "CrivacyKycNFT: empty uri");

        tokenId = _nextId++;
        _meta[tokenId] = Meta({
            customer: customer,
            issuedAt: uint64(block.timestamp),
            serialNumber: serialNumber,
            displayName: displayName,
            uri: uri
        });
        tokenOfCustomer[customer] = tokenId;
        _safeMint(customer, tokenId);
        emit Minted(customer, tokenId, serialNumber);
    }

    /// @notice Burn a customer's pass. Called by the operator directly or by
    ///         the registry as an atomic cascade when a credential is revoked.
    function burn(uint256 tokenId) external onlyAuthorized {
        address customer = _meta[tokenId].customer;
        require(customer != address(0), "CrivacyKycNFT: nonexistent");
        delete tokenOfCustomer[customer];
        delete _meta[tokenId];
        _burn(tokenId);
        emit Burned(customer, tokenId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _meta[tokenId].uri;
    }

    function metaOf(uint256 tokenId) external view returns (Meta memory) {
        return _meta[tokenId];
    }

    /// Soulbound: permit only mint (from == 0) and burn (to == 0); revert any
    /// wallet-to-wallet transfer. Approvals are irrelevant with no transfer path.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert("CrivacyKycNFT: soulbound, non-transferable");
        }
        return super._update(to, tokenId, auth);
    }
}
