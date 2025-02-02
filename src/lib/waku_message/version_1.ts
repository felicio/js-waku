import * as secp from "@noble/secp256k1";
import { concat } from "uint8arrays/concat";

import { keccak256, randomBytes, sign } from "../crypto";
import { hexToBytes } from "../utils";

import * as ecies from "./ecies";
import * as symmetric from "./symmetric";

const FlagsLength = 1;
const FlagMask = 3; // 0011
const IsSignedMask = 4; // 0100
const PaddingTarget = 256;
const SignatureLength = 65;

export const PrivateKeySize = 32;

export type Signature = {
  signature: Uint8Array;
  publicKey: Uint8Array | undefined;
};

/**
 * Encode the payload pre-encryption.
 *
 * @internal
 * @param messagePayload: The payload to include in the message
 * @param sigPrivKey: If set, a signature using this private key is added.
 * @returns The encoded payload, ready for encryption using {@link encryptAsymmetric}
 * or {@link encryptSymmetric}.
 */
export async function clearEncode(
  messagePayload: Uint8Array,
  sigPrivKey?: Uint8Array
): Promise<{ payload: Uint8Array; sig?: Signature }> {
  let envelope = new Uint8Array([0]); // No flags
  envelope = addPayloadSizeField(envelope, messagePayload);
  envelope = concat([envelope, messagePayload]);

  // Calculate padding:
  let rawSize =
    FlagsLength +
    computeSizeOfPayloadSizeField(messagePayload) +
    messagePayload.length;

  if (sigPrivKey) {
    rawSize += SignatureLength;
  }

  const remainder = rawSize % PaddingTarget;
  const paddingSize = PaddingTarget - remainder;
  const pad = randomBytes(paddingSize);

  if (!validateDataIntegrity(pad, paddingSize)) {
    throw new Error("failed to generate random padding of size " + paddingSize);
  }

  envelope = concat([envelope, pad]);

  let sig;
  if (sigPrivKey) {
    envelope[0] |= IsSignedMask;
    const hash = keccak256(envelope);
    const bytesSignature = await sign(hash, sigPrivKey);
    envelope = concat([envelope, bytesSignature]);
    sig = {
      signature: bytesSignature,
      publicKey: secp.getPublicKey(sigPrivKey, false),
    };
  }

  return { payload: envelope, sig };
}

/**
 * Decode a decrypted payload.
 *
 * @internal
 */
export function clearDecode(
  message: Uint8Array
): { payload: Uint8Array; sig?: Signature } | undefined {
  const sizeOfPayloadSizeField = getSizeOfPayloadSizeField(message);
  if (sizeOfPayloadSizeField === 0) return;

  const payloadSize = getPayloadSize(message, sizeOfPayloadSizeField);
  const payloadStart = 1 + sizeOfPayloadSizeField;
  const payload = message.slice(payloadStart, payloadStart + payloadSize);

  const isSigned = isMessageSigned(message);

  let sig;
  if (isSigned) {
    const signature = getSignature(message);
    const hash = getHash(message, isSigned);
    const publicKey = ecRecoverPubKey(hash, signature);
    sig = { signature, publicKey };
  }

  return { payload, sig };
}

function getSizeOfPayloadSizeField(message: Uint8Array): number {
  const messageDataView = new DataView(message.buffer);
  return messageDataView.getUint8(0) & FlagMask;
}

function getPayloadSize(
  message: Uint8Array,
  sizeOfPayloadSizeField: number
): number {
  let payloadSizeBytes = message.slice(1, 1 + sizeOfPayloadSizeField);
  // int 32 == 4 bytes
  if (sizeOfPayloadSizeField < 4) {
    // If less than 4 bytes pad right (Little Endian).
    payloadSizeBytes = concat(
      [payloadSizeBytes, new Uint8Array(4 - sizeOfPayloadSizeField)],
      4
    );
  }
  const payloadSizeDataView = new DataView(payloadSizeBytes.buffer);
  return payloadSizeDataView.getInt32(0, true);
}

function isMessageSigned(message: Uint8Array): boolean {
  const messageDataView = new DataView(message.buffer);
  return (messageDataView.getUint8(0) & IsSignedMask) == IsSignedMask;
}

/**
 * Proceed with Asymmetric encryption of the data as per [26/WAKU-PAYLOAD](https://rfc.vac.dev/spec/26/).
 * The data MUST be flags | payload-length | payload | [signature].
 * The returned result  can be set to `WakuMessage.payload`.
 *
 * @internal
 */
export async function encryptAsymmetric(
  data: Uint8Array,
  publicKey: Uint8Array | string
): Promise<Uint8Array> {
  return ecies.encrypt(hexToBytes(publicKey), data);
}

/**
 * Proceed with Asymmetric decryption of the data as per [26/WAKU-PAYLOAD](https://rfc.vac.dev/spec/26/).
 * The returned data is expected to be `flags | payload-length | payload | [signature]`.
 *
 * @internal
 */
export async function decryptAsymmetric(
  payload: Uint8Array,
  privKey: Uint8Array
): Promise<Uint8Array> {
  return ecies.decrypt(privKey, payload);
}

/**
 * Proceed with Symmetric encryption of the data as per [26/WAKU-PAYLOAD](https://rfc.vac.dev/spec/26/).
 *
 * @param data The data to encrypt, expected to be `flags | payload-length | payload | [signature]`.
 * @param key The key to use for encryption.
 * @returns The decrypted data, `cipherText | tag | iv` and can be set to `WakuMessage.payload`.
 *
 * @internal
 */
export async function encryptSymmetric(
  data: Uint8Array,
  key: Uint8Array | string
): Promise<Uint8Array> {
  const iv = symmetric.generateIv();

  // Returns `cipher | tag`
  const cipher = await symmetric.encrypt(iv, hexToBytes(key), data);
  return concat([cipher, iv]);
}

/**
 * Proceed with Symmetric decryption of the data as per [26/WAKU-PAYLOAD](https://rfc.vac.dev/spec/26/).
 *
 * @param payload The cipher data, it is expected to be `cipherText | tag | iv`.
 * @param key The key to use for decryption.
 * @returns The decrypted data, expected to be `flags | payload-length | payload | [signature]`.
 *
 * @internal
 */
export async function decryptSymmetric(
  payload: Uint8Array,
  key: Uint8Array | string
): Promise<Uint8Array> {
  const ivStart = payload.length - symmetric.IvSize;
  const cipher = payload.slice(0, ivStart);
  const iv = payload.slice(ivStart);

  return symmetric.decrypt(iv, hexToBytes(key), cipher);
}

/**
 * Computes the flags & auxiliary-field as per [26/WAKU-PAYLOAD](https://rfc.vac.dev/spec/26/).
 */
function addPayloadSizeField(msg: Uint8Array, payload: Uint8Array): Uint8Array {
  const fieldSize = computeSizeOfPayloadSizeField(payload);
  let field = new Uint8Array(4);
  const fieldDataView = new DataView(field.buffer);
  fieldDataView.setUint32(0, payload.length, true);
  field = field.slice(0, fieldSize);
  msg = concat([msg, field]);
  msg[0] |= fieldSize;
  return msg;
}

/**
 * Returns the size of the auxiliary-field which in turns contains the payload size
 */
function computeSizeOfPayloadSizeField(payload: Uint8Array): number {
  let s = 1;
  for (let i = payload.length; i >= 256; i /= 256) {
    s++;
  }
  return s;
}

function validateDataIntegrity(
  value: Uint8Array,
  expectedSize: number
): boolean {
  if (value.length !== expectedSize) {
    return false;
  }

  return expectedSize <= 3 || value.findIndex((i) => i !== 0) !== -1;
}

function getSignature(message: Uint8Array): Uint8Array {
  return message.slice(message.length - SignatureLength, message.length);
}

function getHash(message: Uint8Array, isSigned: boolean): Uint8Array {
  if (isSigned) {
    return keccak256(message.slice(0, message.length - SignatureLength));
  }
  return keccak256(message);
}

function ecRecoverPubKey(
  messageHash: Uint8Array,
  signature: Uint8Array
): Uint8Array | undefined {
  const recoveryDataView = new DataView(signature.slice(64).buffer);
  const recovery = recoveryDataView.getUint8(0);
  const _signature = secp.Signature.fromCompact(signature.slice(0, 64));

  return secp.recoverPublicKey(
    messageHash,
    _signature,
    recovery,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: compressed: false
    false
  );
}
