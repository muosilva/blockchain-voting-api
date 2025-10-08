import { randomBytes } from "node:crypto";

import {
  BigInteger,
  ecparams,
  newKeyPair,
  newRequestParameters,
  blindSign,
  unblind
} from "blindsecp256k1";

const CURVE_ORDER = ecparams.n;
const DOMAIN_LABEL = "SimpleVoting:";

function randomScalar() {
  let k;
  do {
    k = BigInteger.fromByteArrayUnsigned(randomBytes(32));
  } while (k.compareTo(BigInteger.ZERO) === 0 || !k.gcd(CURVE_ORDER).equals(BigInteger.ONE));
  return k;
}

function bigIntegerToBigInt(value) {
  return BigInt(value.toString(10));
}

function bigIntegerToHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return `0x${hex}`;
}

function bigIntToHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return `0x${hex}`;
}

function bigIntegerToPrivateKeyHex(value) {
  let hex = value.toString(16);
  while (hex.length < 64) hex = `0${hex}`;
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return `0x${hex}`;
}

function blindCredential(credentialHash, ethers) {
  const { k, signerR } = newRequestParameters();
  const secrets = {
    a: randomScalar(),
    b: randomScalar(),
    f: ecparams.G
  };

  const aR = signerR.multiply(secrets.a);
  const bG = ecparams.G.multiply(secrets.b);
  secrets.f = aR.add(bG);

  const rx = secrets.f.affineX.mod(CURVE_ORDER);
  const ainv = secrets.a.modInverse(CURVE_ORDER);
  const ainvrx = ainv.multiply(rx).mod(CURVE_ORDER);

  const challengeHex = ethers.solidityPackedKeccak256(["string", "bytes32"], [DOMAIN_LABEL, credentialHash]);
  const challenge = BigInteger.fromHex(challengeHex.slice(2));

  const blindedMessage = ainvrx.multiply(challenge).mod(CURVE_ORDER);

  return { blindedMessage, secrets, challengeHex, k };
}

function unblindedToStruct(signature) {
  const fx = bigIntegerToBigInt(signature.f.affineX);
  const fy = bigIntegerToBigInt(signature.f.affineY);
  return {
    s: bigIntegerToBigInt(signature.s),
    fx,
    fy
  };
}

export function createIssuer(ethers) {
  const keyPair = newKeyPair();
  const pubX = bigIntegerToBigInt(keyPair.pk.affineX);
  const pubY = bigIntegerToBigInt(keyPair.pk.affineY);
  const privateKeyHex = bigIntegerToPrivateKeyHex(keyPair.sk);
  const address = ethers.computeAddress(privateKeyHex);

  return {
    keyPair,
    address,
    privateKey: privateKeyHex,
    publicKey: { x: pubX, y: pubY },
    publicKeyHex: { x: bigIntToHex(pubX), y: bigIntToHex(pubY) }
  };
}

export function issueBlindCredential(credentialHash, ethers, issuer) {
  const { blindedMessage, secrets, challengeHex, k } = blindCredential(credentialHash, ethers);
  const sBlind = blindSign(issuer.keyPair.sk, blindedMessage, k);
  const unblindedSignature = unblind(sBlind, secrets);
  const signatureStruct = unblindedToStruct(unblindedSignature);

  return {
    signatureStruct,
    challengeHex,
    blindedMessageHex: bigIntegerToHex(blindedMessage),
    blindSignatureHex: bigIntegerToHex(sBlind)
  };
}

export function signatureStructToHex(signatureStruct) {
  return {
    s: bigIntToHex(signatureStruct.s),
    fx: bigIntToHex(signatureStruct.fx),
    fy: bigIntToHex(signatureStruct.fy)
  };
}
