import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";

export const loadKeypair = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

export function loadOrCreate(name: string): Keypair {
  const dir = path.join(__dirname, "..", ".keys");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}