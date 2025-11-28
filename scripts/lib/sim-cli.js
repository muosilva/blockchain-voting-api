import path from "node:path";

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "scripts", "simulations.generated.json");

export function parseArgs(argv) {
  const args = { extras: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--config" || value === "-c") {
      args.configPath = argv[++i];
    } else if (value?.startsWith("--config=")) {
      args.configPath = value.split("=", 2)[1];
    } else if (value === "--scenario" || value === "-s") {
      args.scenarioId = argv[++i];
    } else if (value?.startsWith("--scenario=")) {
      args.scenarioId = value.split("=", 2)[1];
    } else if (value === "--list" || value === "-l") {
      args.list = true;
    } else if (value === "--network" || value === "-n") {
      args.networkName = argv[++i];
    } else if (value?.startsWith("--network=")) {
      args.networkName = value.split("=", 2)[1];
    } else if (["--contract", "--voting", "--vote-contract"].includes(value)) {
      args.contractAddress = argv[++i];
    } else if (value?.startsWith("--contract=") || value?.startsWith("--voting=") || value?.startsWith("--vote-contract=")) {
      args.contractAddress = value.split("=", 2)[1];
    } else if (["--stake", "--stake-token"].includes(value)) {
      args.stakeTokenAddress = argv[++i];
    } else if (value?.startsWith("--stake=") || value?.startsWith("--stake-token=")) {
      args.stakeTokenAddress = value.split("=", 2)[1];
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value) {
      args.extras.push(value);
    }
  }
  return args;
}

export function printHelp(defaultPath) {
  console.log("Uso: node scripts/simulate.js [--config caminho] [--scenario id] [--list]");
  console.log("  --config, -c   Define o caminho do arquivo JSON de simulacoes.");
  console.log("                 Padrao:", defaultPath);
  console.log("  --scenario,-s  Executa apenas a simulacao informada (aceita multiplos IDs separados por virgula).");
  console.log("  --list,   -l   Lista as simulacoes disponiveis no JSON e encerra.");
  console.log("  --network,-n  Forca o uso de uma rede definida no hardhat.config (ex.: localhost).");
  console.log("  --contract     Reaproveita um contrato ja implantado (TokenizedVoting ou SimpleVoting).");
  console.log("  --stake        Reaproveita um StakeToken ja implantado para simulacoes TokenizedVoting.");
  console.log("  --help,   -h   Exibe esta mensagem.");
}
