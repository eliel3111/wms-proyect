// utils/alegraAuth.js

export function getAlegraAuthHeader() {
  const email = process.env.ALEGRA_EMAIL;
  const token = process.env.ALEGRA_TOKEN;
  console.log("EMAIL", email);
  console.log("TOKEN", token);
  if (!email || !token) {
    throw new Error("ALEGRA credentials missing");
  }

  const base64 = Buffer
    .from(`${email}:${token}`)
    .toString("base64");

  return `Basic ${base64}`;
}