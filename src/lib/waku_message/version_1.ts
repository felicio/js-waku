import { Buffer } from 'buffer';
import { randomBytes } from 'crypto';

import { keccak256 } from 'js-sha3';
import * as secp256k1 from 'secp256k1';

import { hexToBuf } from '../utils';

const FlagsLength = 1;
const FlagMask = 3; // 0011
const IsSignedMask = 4; // 0100
const PaddingTarget = 256;
const SignatureLength = 65;

/**
 *  Encode a Waku Message Payload using version 1. Payload get encrypted and
 *  a signature may be included
 * @param messagePayload: The payload to include in the message
 * @param sigPrivKey: If set, a signature using this private key is added.
 */

export function encode(
  messagePayload: Uint8Array,
  sigPrivKey?: Uint8Array
): Uint8Array {
  let envelope = Buffer.from([0]); // No flags
  envelope = addPayloadSizeField(envelope, messagePayload);
  envelope = Buffer.concat([envelope, messagePayload]);

  // Calculate padding:
  let rawSize =
    FlagsLength +
    getSizeOfPayloadSizeField(messagePayload) +
    messagePayload.length;

  if (sigPrivKey) {
    rawSize += SignatureLength;
  }

  const remainder = rawSize % PaddingTarget;
  const paddingSize = PaddingTarget - remainder;
  const pad = randomBytes(paddingSize);

  if (!validateDataIntegrity(pad, paddingSize)) {
    throw new Error('failed to generate random padding of size ' + paddingSize);
  }

  envelope = Buffer.concat([envelope, pad]);

  if (sigPrivKey) {
    envelope[0] |= IsSignedMask;
    const hash = keccak256(envelope);
    const s = secp256k1.ecdsaSign(hexToBuf(hash), sigPrivKey);
    envelope = Buffer.concat([envelope, s.signature, Buffer.from([s.recid])]);
  }

  return envelope;
}

export type DecodeResult = {
  payload: Uint8Array;
  sig?: {
    signature: Uint8Array;
    publicKey: Uint8Array;
  };
};

export function decode(message: Uint8Array | Buffer): DecodeResult | undefined {
  const buf = Buffer.from(message);

  let start = 1;
  let sig;

  const sizeOfPayloadSizeField = buf.readUIntLE(0, 1) & FlagMask;

  if (sizeOfPayloadSizeField === 0) return;

  const payloadSize = buf.readUIntLE(start, sizeOfPayloadSizeField);
  start += sizeOfPayloadSizeField;
  const payload = buf.slice(start, start + payloadSize);

  const isSigned = (buf.readUIntLE(0, 1) & IsSignedMask) == IsSignedMask;
  if (isSigned) {
    const signature = getSignature(buf);
    const hash = getHash(buf, isSigned);
    const publicKey = ecRecoverPubKey(hash, signature);
    sig = { signature, publicKey };
  }

  return { payload, sig };
}

/**
 * Computes the flags & auxiliary-field as per [26/WAKU-PAYLOAD](rfc.vac.dev/spec/26/).
 */
function addPayloadSizeField(msg: Buffer, payload: Uint8Array): Buffer {
  const fieldSize = getSizeOfPayloadSizeField(payload);
  let field = Buffer.alloc(4);
  field.writeUInt32LE(payload.length, 0);
  field = field.slice(0, fieldSize);
  msg = Buffer.concat([msg, field]);
  msg[0] |= fieldSize;
  return msg;
}

/**
 * Returns the size of the auxiliary-field which in turns contains the payload size
 */
function getSizeOfPayloadSizeField(payload: Uint8Array): number {
  let s = 1;
  for (let i = payload.length; i >= 256; i /= 256) {
    s++;
  }
  return s;
}

function validateDataIntegrity(value: Buffer, expectedSize: number): boolean {
  if (value.length !== expectedSize) {
    return false;
  }

  if (expectedSize > 3 && value.equals(Buffer.alloc(value.length))) {
    return false;
  }

  return true;
}

function getSignature(message: Buffer): Buffer {
  return message.slice(message.length - SignatureLength, message.length);
}

function getHash(message: Buffer, isSigned: boolean): string {
  if (isSigned) {
    return keccak256(message.slice(0, message.length - SignatureLength));
  }
  return keccak256(message);
}

function ecRecoverPubKey(messageHash: string, signature: Buffer): Uint8Array {
  const recovery = signature.slice(64).readIntBE(0, 1);
  return secp256k1.ecdsaRecover(
    signature.slice(0, 64),
    recovery,
    hexToBuf(messageHash),
    false
  );
}
