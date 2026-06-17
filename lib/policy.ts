export const acceptableUsePath = "/acceptable-use";

export const prohibitedUses = [
  "Spam, unsolicited bulk messaging, phishing, credential harvesting, or impersonation.",
  "Network scanning, vulnerability probing, exploitation, denial-of-service activity, or traffic amplification against systems you do not own or have explicit permission to test.",
  "Malware, botnets, command-and-control infrastructure, cryptojacking, or evasion tooling.",
  "Cryptocurrency mining or other resource-draining workloads unrelated to the stated task.",
  "Hosting, storing, or distributing illegal, infringing, abusive, or deceptive content.",
  "Bypassing access controls, rate limits, geofencing, sanctions controls, or platform safety systems.",
  "Processing highly sensitive data unless you have appropriate authorization, safeguards, and legal basis.",
];

export const acceptableUseMarkdown = `# Acceptable Use

This storefront leases short-lived Linux machines for legitimate development, automation, testing, debugging, and compute tasks.

By checking out a machine, the buyer and any agent acting for the buyer agree to use the machine only for lawful, authorized activity and to stop using it when the task is complete.

## Prohibited Uses

Do not use leased machines for:

${prohibitedUses.map((item) => `- ${item}`).join("\n")}

## Operational Rules

- Treat read, extend, and terminate tokens as secrets.
- Do not expose machine credentials, management tokens, or SSH keys in logs or public output.
- Poll until the machine is active before using SSH.
- Terminate the machine as soon as the task is complete.
- Use the extend token only when more time is necessary for the same legitimate task.

## Enforcement

We may terminate machines, revoke access, refuse future checkouts, or block payment identities for abuse, suspected abuse, provider complaints, sanctions risk, payment risk, or violations of these rules.

Hetzner Cloud provider policies also apply to machines provisioned by this service.
`;
