import { App } from "./app.js";
import { mountApp } from "./mount-app.js";
import "./tokens.css";
import "./viewer.css";

mountApp("viewer", (client) => <App client={client} />);
