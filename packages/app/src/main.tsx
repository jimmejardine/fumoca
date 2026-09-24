import { createApp } from "./createApp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// The open-source build: built-in providers only.
createApp(root, { providers: [] });
