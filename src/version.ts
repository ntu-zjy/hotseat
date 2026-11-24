// 打包时由 esbuild 替换；直接运行源码时为开发版本。
declare const __HOTSEAT_VERSION__: string | undefined;

export const VERSION: string = typeof __HOTSEAT_VERSION__ === "string" ? __HOTSEAT_VERSION__ : "0.0.0-dev";
