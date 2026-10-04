import { render } from "preact";
import { Home } from "./components/Home";
import { Radar } from "./components/Radar";
import "./styles.css";

function App() {
	const match = location.pathname.match(/^\/p\/([a-z0-9-]+)/);
	const fixture = new URLSearchParams(location.search).get("fixture");
	if (match) return <Radar slug={match[1]} fixture={fixture} />;
	return <Home />;
}

render(<App />, document.getElementById("app")!);
