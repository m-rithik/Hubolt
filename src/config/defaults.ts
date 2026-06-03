import { RepoConfigSchema, type RepoConfig } from "./schema.js";

export const DEFAULT_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});
export const DEFAULT_CONFIG_FILE = ".hubolt.yml";
