import "blessed";

declare module "blessed" {
  interface BlessedProgram {
    mouseEnabled?: boolean;
  }
}
