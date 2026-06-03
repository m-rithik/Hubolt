const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  bgRed: "\x1b[41m"
};

function style(value: string, codes: string[]): string {
  if (!colorEnabled) {
    return value;
  }

  return `${codes.join("")}${value}${ansi.reset}`;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export const ui = {
  title(value: string): string {
    return style(value, [ansi.bold, ansi.cyan]);
  },
  success(value: string): string {
    return style(value, [ansi.green]);
  },
  error(value: string): string {
    return style(value, [ansi.red]);
  },
  warn(value: string): string {
    return style(value, [ansi.yellow]);
  },
  info(value: string): string {
    return style(value, [ansi.cyan]);
  },
  critical(value: string): string {
    return style(` ${value} `, [ansi.bold, ansi.white, ansi.bgRed]);
  },
  label(value: string): string {
    return style(value, [ansi.dim]);
  },
  muted(value: string): string {
    return style(value, [ansi.gray]);
  },
  section(title: string, rows: Array<[string, string]>): string {
    const width = Math.max(...rows.map(([label]) => label.length), 0);
    const valueWidth = Math.max(...rows.map(([, value]) => visibleLength(value)), 0);
    const body = rows.map(([label, value]) => `${ui.label(label.padEnd(width))}  ${value}`);
    const ruleWidth = Math.max(title.length, width + 2 + valueWidth);
    const rule = ui.muted("-".repeat(ruleWidth));

    return [ui.title(title), rule, ...body].join("\n");
  },
  table(rows: Array<[string, string]>, indent = 2): string {
    const prefix = " ".repeat(indent);
    const width = Math.max(...rows.map(([label]) => label.length), 0);

    return rows
      .map(([label, value]) => `${prefix}${ui.label(label.padEnd(width))}  ${value}`.trimEnd())
      .join("\n");
  },
  rule(): string {
    return ui.muted("--------------------------------------------------");
  },
  grid(headers: string[], rows: string[][], indent = 2): string {
    const widths = headers.map((header, column) =>
      Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? "")))
    );
    const prefix = " ".repeat(indent);
    const pad = (value: string, width: number): string =>
      value + " ".repeat(Math.max(0, width - visibleLength(value)));

    const headerLine = prefix + headers.map((header, column) => ui.label(pad(header, widths[column]))).join("  ");
    const body = rows.map(
      (row) => prefix + row.map((cell, column) => pad(cell ?? "", widths[column])).join("  ").trimEnd()
    );

    return [headerLine, ...body].join("\n");
  }
};
