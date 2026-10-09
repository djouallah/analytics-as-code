// Errors the compiler raises. `code` says which kind:
//   SYNTAX       the text is not DAX
//   SEMANTIC     DAX, but wrong for this model (an unknown table, a column with no row context)
//   UNSUPPORTED  valid DAX that this compiler does not translate
export class DaxError extends Error {
  constructor(message, { code = 'SEMANTIC', pos = null, src = null } = {}) {
    super(pos != null && src != null ? `${message} at ${where(src, pos)}` : message);
    this.name = 'DaxError';
    this.code = code;
    this.pos = pos;
  }
}

function where(src, pos) {
  const before = src.slice(0, pos), line = before.split('\n').length, col = pos - before.lastIndexOf('\n');
  return `line ${line}, column ${col}: "${src.slice(pos, pos + 30).replace(/\s+/g, ' ')}"`;
}

export const syntax = (msg, pos, src) => new DaxError(`DAX syntax: ${msg}`, { code: 'SYNTAX', pos, src });
export const semantic = msg => new DaxError(`DAX: ${msg}`, { code: 'SEMANTIC' });
export const unsupported = msg => new DaxError(`DAX: ${msg} is not supported`, { code: 'UNSUPPORTED' });
