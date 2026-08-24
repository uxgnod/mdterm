import type { ThemePalette } from "../theme";

export interface ListItemStyle {
  fg: string;
  bg: string;
  bold: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
}

export interface ListStyle {
  fg: string;
  bg: string;
  item: ListItemStyle;
  selected: ListItemStyle;
}

/**
 * neo-blessed list items read every item attribute through style.item. Keep
 * both nested styles complete when a theme is replaced at runtime; a partial
 * style can otherwise crash while the list redraws after a resize.
 */
export function listStyle(theme: ThemePalette): ListStyle {
  return {
    fg: theme.foreground,
    bg: theme.background,
    item: {
      fg: theme.foreground,
      bg: theme.background,
      bold: false,
      underline: false,
      blink: false,
      inverse: false,
      invisible: false,
    },
    selected: {
      fg: theme.selectedForeground,
      bg: theme.selectedBackground,
      bold: true,
      underline: false,
      blink: false,
      inverse: false,
      invisible: false,
    },
  };
}
