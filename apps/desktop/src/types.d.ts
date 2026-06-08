// auto-launch ships no types; minimal declaration for what we use.
declare module "auto-launch" {
  interface AutoLaunchOptions {
    name: string;
    path?: string;
    isHidden?: boolean;
  }
  export default class AutoLaunch {
    constructor(options: AutoLaunchOptions);
    enable(): Promise<void>;
    disable(): Promise<void>;
    isEnabled(): Promise<boolean>;
  }
}
