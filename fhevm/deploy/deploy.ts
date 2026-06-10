import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute, read } = hre.deployments;

  // Deployer becomes the operator / gatekeeper on both contracts.
  const nft = await deploy("CrivacyKycNFT", {
    from: deployer,
    args: [deployer],
    log: true,
  });

  const registry = await deploy("CrivacyKYC", {
    from: deployer,
    log: true,
  });

  // Wire the two together so revoke can cascade-burn the NFT atomically.
  const linkedNft: string = await read("CrivacyKYC", "nft");
  if (linkedNft.toLowerCase() !== nft.address.toLowerCase()) {
    await execute("CrivacyKYC", { from: deployer, log: true }, "linkNft", nft.address);
  }
  const linkedRegistry: string = await read("CrivacyKycNFT", "registry");
  if (linkedRegistry.toLowerCase() !== registry.address.toLowerCase()) {
    await execute("CrivacyKycNFT", { from: deployer, log: true }, "setRegistry", registry.address);
  }

  console.log(`CrivacyKYC (registry) : ${registry.address}`);
  console.log(`CrivacyKycNFT (pass)  : ${nft.address}`);
  console.log(`Operator (gatekeeper) : ${deployer}`);
};

export default func;
func.id = "deploy_crivacy_kyc";
func.tags = ["CrivacyKYC"];
