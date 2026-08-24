import { main } from "./cli";

if (require.main === module) {
  void main(process.argv.slice(2), "md").then((code) => {
    process.exitCode = code;
  });
}
