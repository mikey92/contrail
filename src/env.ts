import type { Registry } from "./registry";
import type { Runway } from "./runway/runway";
import type { Tower } from "./tower/tower";

export interface Env {
	ARTIFACTS: Artifacts;
	LOADER: WorkerLoader;
	TOWER: DurableObjectNamespace<Tower>;
	RUNWAY: DurableObjectNamespace<Runway>;
	REGISTRY: DurableObjectNamespace<Registry>;
	ASSETS: Fetcher;
	/** Admin key for creating projects and intents. */
	CONTRAIL_ADMIN_KEY: string;
	/** Public origin used in onboarding commands, e.g. https://contrail.example.workers.dev */
	PUBLIC_ORIGIN?: string;
}
