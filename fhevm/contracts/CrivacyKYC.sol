// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import { FHE, euint8, ebool, externalEuint8, externalEbool } from "@fhevm/solidity/lib/FHE.sol";
import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

interface ICrivacyKycNFT {
    function tokenOfCustomer(address customer) external view returns (uint256);
    function burn(uint256 tokenId) external;
}

/// @title CrivacyKYC — confidential, reusable, user-owned KYC credential registry
/// @notice Confidential (FHE) KYC credential registry (crivacy-kyc-v2 v1.1.1).
///
/// Privacy model:
///   - Sensitive KYC results (level, humanScore, identity/liveness/address
///     verification flags, sanctioned) are ENCRYPTED (euint/ebool) and stored
///     on the public chain as ciphertext. Computation (eligibility) runs on the
///     ciphertext without decryption.
///   - Lifecycle metadata (userRefHash, proofHash, status, validUntil,
///     validator, issuedAt) is plaintext — it is not PII and the contract needs
///     it for on-chain logic (isActive, supersede, audit).
///   - `userRefHash = keccak256(firm userRef)`: a firm confirms "this credential
///     is for the user I expect" by recomputing the hash, without the raw ref
///     ever appearing on chain.
///
/// Gatekeeper model (Crivacy is the access authorizer, not a chain validator):
///   - A relying firm can decrypt a user's eligibility/fields only AFTER the
///     operator grants per-firm ACL access via `grantAccess`. The user cannot
///     bypass Crivacy to hand a firm access; equally, the operator holds no PII.
///   - The user OWNS their record: they can decrypt their own data and can
///     self-revoke (`revokeMine`) — a capability enabled by holding
///     real EVM keys to their own record.
contract CrivacyKYC is ZamaEthereumConfig {
    // ── roles ───────────────────────────────────────────────────────────
    address public operator; // Crivacy issuer / gatekeeper
    ICrivacyKycNFT public nft; // soulbound showcase NFT (cascade burn on revoke)

    // ── enums ───────────────────────────────────────────────────────────
    enum Status {
        None,
        Active,
        Revoked,
        Expired
    }
    enum ValidatorType {
        Didit,
        Chain,
        ZK
    }

    // ── stored credential ───────────────────────────────────────────────
    struct Credential {
        // plaintext lifecycle metadata
        bytes32 userRefHash; // keccak256(firm userRef) — equality-testable, value not leaked
        bytes32 proofHash; // off-chain Didit decision commitment
        Status status;
        ValidatorType validator;
        uint64 validUntil;
        uint64 issuedAt;
        bool exists;
        // encrypted KYC data
        euint8 level; // 1 = Basic, 2 = Enhanced
        euint8 humanScore; // 0..100
        ebool identityVerified;
        ebool livenessVerified;
        ebool addressVerified;
        ebool sanctioned;
    }

    mapping(address => Credential) private _cred; // user => credential
    mapping(address => mapping(address => ebool)) private _grant; // user => firm => eligible

    // ── events (lifecycle / audit trail) ────────────────────────────────
    event CredentialIssued(
        address indexed user,
        bytes32 userRefHash,
        bytes32 proofHash,
        uint8 validator,
        uint64 validUntil
    );
    event AccessGranted(address indexed user, address indexed firm);
    event AccessRevoked(address indexed user, address indexed firm);
    event CredentialRevoked(address indexed user, bool byOperator, bool nftBurned);
    event CredentialErased(address indexed user);
    event ValidatorMigrated(address indexed user, uint8 newValidator);
    event OperatorChanged(address indexed newOperator);
    event NftLinked(address indexed nft);

    modifier onlyOperator() {
        require(msg.sender == operator, "CrivacyKYC: not operator");
        _;
    }

    constructor() {
        operator = msg.sender;
    }

    function linkNft(address nft_) external onlyOperator {
        nft = ICrivacyKycNFT(nft_);
        emit NftLinked(nft_);
    }

    function setOperator(address newOperator) external onlyOperator {
        require(newOperator != address(0), "CrivacyKYC: zero operator");
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    // ── issuance ─────────────────────────────────────────────────────────
    // The six encrypted values arrive in ONE relayer input bundle, so they
    // share a single `inputProof`. Packed in a struct to stay under Solidity's
    // stack-depth limit.
    struct EncryptedInputs {
        externalEuint8 level;
        externalEuint8 humanScore;
        externalEbool identityVerified;
        externalEbool livenessVerified;
        externalEbool addressVerified;
        externalEbool sanctioned;
    }

    function setCredential(
        address user,
        bytes32 userRefHash,
        bytes32 proofHash,
        uint64 validUntil,
        ValidatorType validator,
        EncryptedInputs calldata enc,
        bytes calldata inputProof
    ) external onlyOperator {
        require(user != address(0), "CrivacyKYC: zero user");
        require(userRefHash != bytes32(0), "CrivacyKYC: empty userRef");

        Credential storage c = _cred[user];
        c.userRefHash = userRefHash;
        c.proofHash = proofHash;
        c.status = Status.Active;
        c.validator = validator;
        c.validUntil = validUntil;
        c.issuedAt = uint64(block.timestamp);
        c.exists = true;
        c.level = FHE.fromExternal(enc.level, inputProof);
        c.humanScore = FHE.fromExternal(enc.humanScore, inputProof);
        c.identityVerified = FHE.fromExternal(enc.identityVerified, inputProof);
        c.livenessVerified = FHE.fromExternal(enc.livenessVerified, inputProof);
        c.addressVerified = FHE.fromExternal(enc.addressVerified, inputProof);
        c.sanctioned = FHE.fromExternal(enc.sanctioned, inputProof);

        // ACL: the contract keeps compute rights; the user owns/reads own data.
        _allowSelfAndUser(user);

        emit CredentialIssued(user, userRefHash, proofHash, uint8(validator), validUntil);
    }

    function _allowSelfAndUser(address user) internal {
        Credential storage c = _cred[user];
        // Contract keeps compute rights.
        FHE.allowThis(c.level);
        FHE.allowThis(c.humanScore);
        FHE.allowThis(c.identityVerified);
        FHE.allowThis(c.livenessVerified);
        FHE.allowThis(c.addressVerified);
        FHE.allowThis(c.sanctioned);
        // The user (owner) and the operator (issuer — ran the KYC, powers the
        // firm-facing verify endpoint) can both decrypt off-chain. A relying
        // firm gets ACL only later, via grantAccess.
        _grantFieldDecryption(c, user);
        _grantFieldDecryption(c, operator);
    }

    function _grantFieldDecryption(Credential storage c, address who) internal {
        FHE.allow(c.level, who);
        FHE.allow(c.humanScore, who);
        FHE.allow(c.identityVerified, who);
        FHE.allow(c.livenessVerified, who);
        FHE.allow(c.addressVerified, who);
        FHE.allow(c.sanctioned, who);
    }

    // ── eligibility (confidential compute) ──────────────────────────────
    function _eligible(address user, uint8 minLevel) internal returns (ebool) {
        Credential storage c = _cred[user];
        require(c.exists, "CrivacyKYC: no record");
        ebool meetsLevel = FHE.ge(c.level, minLevel);
        return FHE.and(meetsLevel, FHE.not(c.sanctioned));
    }

    // ── per-firm access grant (Crivacy gatekeeper) ──────────────────────
    // Replaces off-chain disclosure-blob distribution. A firm cannot decrypt
    // anything until the operator grants it here — the user cannot bypass
    // Crivacy, and Crivacy never holds PII.
    function grantAccess(address user, address firm, uint8 minLevel) external onlyOperator {
        require(firm != address(0), "CrivacyKYC: zero firm");
        Credential storage c = _cred[user];
        require(c.exists && c.status == Status.Active, "CrivacyKYC: not active");

        ebool eligible = _eligible(user, minLevel);
        _grant[user][firm] = eligible;

        // Confidential gating: the firm may decrypt ONLY the eligibility
        // verdict ("meets my threshold: yes/no"), never the raw level / score /
        // flags. The firm verifies trustlessly (reads + decrypts on chain, no
        // Crivacy API) yet learns nothing beyond the verdict — and per-firm
        // revoke is fully effective because the firm never held the raw fields
        // to go stale on. The user's current active status is read separately
        // from the plaintext `status` / `isActive` in `verify()`.
        FHE.allowThis(eligible);
        FHE.allow(eligible, firm);

        emit AccessGranted(user, firm);
    }

    // ── per-firm access revoke (Crivacy gatekeeper) ─────────────────────
    // A firm's deal ends → close just that firm, leave the others open.
    // Deletes the firm's stored grant so it can no longer fetch a fresh
    // handle from the contract to re-verify the user's CURRENT state (same
    // effect as archiving the disclosed contract: the firm's next
    // read returns an empty handle and its decrypt fails). Other firms'
    // grants are untouched.
    //
    // Honest limitation: a firm that already decrypted the values off-chain
    // keeps that stale snapshot — no system can claw back data a counterparty
    // has already seen. What revoke removes is the firm's
    // ability to re-check the user going forward; once the credential changes
    // (revoked / expired / level upgrade) the firm's stale copy is worthless
    // and it has no grant to obtain the fresh state.
    function revokeAccess(address user, address firm) external onlyOperator {
        // Reset the grant to the uninitialized (zero) handle. `delete` cannot
        // be applied to the `ebool` user-defined value type, so we assign the
        // zero handle explicitly — a subsequent `eligibilityFor` read returns
        // this empty handle and the firm's decrypt yields no positive verdict.
        _grant[user][firm] = ebool.wrap(bytes32(0));
        emit AccessRevoked(user, firm);
    }

    // ── verify ─────────────────────────────────────────────────────────
    struct CredentialView {
        bytes32 userRefHash;
        bytes32 proofHash;
        Status status;
        ValidatorType validator;
        uint64 validUntil;
        uint64 issuedAt;
        bool isActive;
        euint8 level;
        euint8 humanScore;
        ebool identityVerified;
        ebool livenessVerified;
        ebool addressVerified;
        ebool sanctioned;
        ebool eligible; // caller-specific grant (uninitialized handle if not granted)
    }

    function _buildView(address user, address viewer) internal view returns (CredentialView memory v) {
        Credential storage c = _cred[user];
        bool active = c.status == Status.Active && block.timestamp <= c.validUntil;
        v = CredentialView({
            userRefHash: c.userRefHash,
            proofHash: c.proofHash,
            status: c.status,
            validator: c.validator,
            validUntil: c.validUntil,
            issuedAt: c.issuedAt,
            isActive: active,
            level: c.level,
            humanScore: c.humanScore,
            identityVerified: c.identityVerified,
            livenessVerified: c.livenessVerified,
            addressVerified: c.addressVerified,
            sanctioned: c.sanctioned,
            eligible: _grant[user][viewer]
        });
    }

    /// Firm-facing verify: lifecycle in plaintext, sensitive fields as handles
    /// (decryptable only if the caller was granted access).
    function verify(address user) external view returns (CredentialView memory) {
        require(_cred[user].exists, "CrivacyKYC: no record");
        return _buildView(user, msg.sender);
    }

    /// User-facing read of their own credential.
    function myCredential() external view returns (CredentialView memory) {
        require(_cred[msg.sender].exists, "CrivacyKYC: no record");
        return _buildView(msg.sender, msg.sender);
    }

    /// Convenience: a firm reads just its eligibility handle for a user.
    function eligibilityFor(address user) external view returns (ebool) {
        return _grant[user][msg.sender];
    }

    // ── revocation & lifecycle ──────────────────────────────────────────
    // Operator revoke: fraud signal, admin action, chargeback, level-upgrade
    // supersede. Sets status = Revoked (audit trail preserved) and optionally
    // cascade-burns the bound NFT in the same transaction.
    function revokeCredential(address user, bool burnNft) external onlyOperator {
        Credential storage c = _cred[user];
        require(c.exists, "CrivacyKYC: no record");
        c.status = Status.Revoked;
        bool burned = _maybeBurnNft(user, burnNft);
        emit CredentialRevoked(user, true, burned);
    }

    // User self-revoke, enabled by real EVM ownership of the record.
    function revokeMine() external {
        Credential storage c = _cred[msg.sender];
        require(c.exists, "CrivacyKYC: no record");
        c.status = Status.Revoked;
        bool burned = _maybeBurnNft(msg.sender, true);
        emit CredentialRevoked(msg.sender, false, burned);
    }

    // GDPR right-to-erasure: remove the record (and NFT) from contract state.
    // The residual ciphertext in history is inert — no ACL grant can ever be
    // issued for a deleted record, so it is permanently undecryptable.
    function eraseCredential(address user) external onlyOperator {
        Credential storage c = _cred[user];
        require(c.exists, "CrivacyKYC: no record");
        _maybeBurnNft(user, true);
        delete _cred[user];
        emit CredentialErased(user);
    }

    function _maybeBurnNft(address user, bool burnNft) internal returns (bool) {
        if (!burnNft || address(nft) == address(0)) {
            return false;
        }
        uint256 tokenId = nft.tokenOfCustomer(user);
        if (tokenId == 0) {
            return false;
        }
        nft.burn(tokenId);
        return true;
    }

    // Reserved for the ZK-validator migration path: re-point a credential's
    // validator without re-running the KYC pipeline.
    function migrateValidator(address user, ValidatorType newValidator) external onlyOperator {
        Credential storage c = _cred[user];
        require(c.exists, "CrivacyKYC: no record");
        c.validator = newValidator;
        emit ValidatorMigrated(user, uint8(newValidator));
    }
}
