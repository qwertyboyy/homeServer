import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

// Reads the password without echoing it, so it never lands in shell history.
let muted = false;
const output = new Writable({
  write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  },
});

const rl = createInterface({ input: process.stdin, output, terminal: true });
process.stdout.write("New admin password: ");
muted = true;
const password = await rl.question("");
muted = false;
rl.close();
process.stdout.write("\n");

if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log("\nPut this in your .env (single quotes keep the $ characters intact):\n");
console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
