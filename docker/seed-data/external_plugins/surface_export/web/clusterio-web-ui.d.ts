/**
 * Type declarations for @clusterio/web_ui module
 * This module is provided by the Clusterio framework at runtime
 */
declare module "@clusterio/web_ui" {
	import * as React from "react";

	export class BaseWebPlugin {
		constructor(...args: any[]);
		init(): Promise<void>;
		onStart(): Promise<void>;
		onStop(): Promise<void>;
	}

	export interface ControlContextType {
		control: any;
		plugins: Map<string, any>;
		[key: string]: any;
	}

	export const ControlContext: React.Context<ControlContextType>;

	export interface PageHeaderProps {
		title: string;
		[key: string]: any;
	}

	export const PageHeader: React.FC<PageHeaderProps>;

	export interface PageLayoutProps {
		nav?: any;
		children: React.ReactNode;
		[key: string]: any;
	}

	export const PageLayout: React.FC<PageLayoutProps>;

	export function notifyErrorHandler(message: string): (error: unknown) => void;

	export function useItemMetadata(): Record<string, any>;
	export function useEntityMetadata(): Record<string, any>;
	export function usePlanetMetadata(): Record<string, any>;
}
