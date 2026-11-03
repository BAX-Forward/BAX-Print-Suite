// Fallback typing for the dev-only dxf-parser. When the package ships its own
// declarations they take precedence; `parseDxf` in helpers.ts casts either way.
declare module "dxf-parser";
