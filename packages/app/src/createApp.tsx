import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "dockview-react/dist/styles/dockview.css";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

export interface AppOptions {
  /**
   * Storage providers registered at build time (SPECS.md §8.3). The open-source build passes only
   * the built-in providers; the fumoca.com build adds the cloud provider from its private repo.
   * Typed as `unknown` until the provider interface exists in @fumoca/storage.
   */
  providers: readonly unknown[];
}

export function createApp(container: HTMLElement, _options: AppOptions): void {
  createRoot(container).render(
    <StrictMode>
      <MantineProvider defaultColorScheme="auto">
        <ModalsProvider>
          <Notifications />
          <App />
        </ModalsProvider>
      </MantineProvider>
    </StrictMode>,
  );
}
