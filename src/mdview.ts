import { main } from "./cli";

if (require.main === module) {
  void main(process.argv.slice(2), "mdview").then((code) => {
    process.exitCode = code;
  });
}
