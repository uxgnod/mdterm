declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  type Formatter = (value: string) => string;

  export interface MarkedTerminalOptions {
    code?: Formatter;
    blockquote?: Formatter;
    html?: Formatter;
    heading?: Formatter;
    firstHeading?: Formatter;
    hr?: Formatter;
    listitem?: Formatter;
    table?: Formatter;
    paragraph?: Formatter;
    strong?: Formatter;
    em?: Formatter;
    codespan?: Formatter;
    del?: Formatter;
    link?: Formatter;
    href?: Formatter;
    text?: Formatter;
    image?: (href: string, title: string | null, text: string) => string;
    width?: number;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
    unescape?: boolean;
    emoji?: boolean;
    tab?: number | string;
    tableOptions?: Record<string, unknown>;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
