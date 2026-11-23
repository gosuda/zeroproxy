export interface WasmArtifactRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WasmManifest {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly transformerVersion: string;
  readonly wasmBindgenVersion: string;
  readonly buildId: string;
  readonly artifacts: readonly WasmArtifactRecord[];
}

export interface WebAssetData {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

export declare const distDir: string;
export declare const webDistDir: string;
export declare const wasmDistDir: string;
export declare const wasmManifestPath: string;
export declare const ASSET_CONTENT_TYPES: Readonly<Record<string, string>>;

export declare function readWebAsset(relativePath: string): Promise<WebAssetData>;
export declare function readWasmManifest(): Promise<WasmManifest>;
