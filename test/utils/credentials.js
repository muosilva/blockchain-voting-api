import { getBytes, id, solidityPackedKeccak256 } from "ethers";

export function credentialHashFrom(label) {
  return id(`credential:${label}`);
}

export function saltFrom(label) {
  return id(`salt:${label}`);
}

export function computeCommitment(credentialHash, optionIndex, salt, committer) {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "address"],
    [credentialHash, optionIndex, salt, committer]
  );
}

export async function signCredential(issuer, credentialHash) {
  const inner = solidityPackedKeccak256(["string", "bytes32"], ["SimpleVoting:", credentialHash]);
  return issuer.signMessage(getBytes(inner));
}
