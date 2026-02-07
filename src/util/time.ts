export function formatTimestampForPath(date = new Date()): string {
  // YYYYMMDD-HHMMSS
  const pad = pad2;
  const MONTH_OFFSET = 1;
  return `${date.getFullYear()}${pad(date.getMonth() + MONTH_OFFSET)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

export function formatTimestampForCommit(date = new Date()): string {
  // YYYY-MM-DD HH:mm
  const pad = pad2;
  const MONTH_OFFSET = 1;
  return `${date.getFullYear()}-${pad(date.getMonth() + MONTH_OFFSET)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function pad2(n: number): string {
  const PAD_WIDTH = 2;
  return String(n).padStart(PAD_WIDTH, "0");
}
