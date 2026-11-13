// The OpenCode 1.x plugin, as OpenCode 1.x and magpie's host load it: the
// default {id, server} from src/index.ts and nothing else. OpenCode 2.x loads
// opencode2.mjs, which runs it.
export { default } from "./src/index.ts"
