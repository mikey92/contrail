import { render } from "preact";
import { Center } from "./components/Center";
import { Home } from "./components/Home";
import { Radar } from "./components/Radar";
import "./styles.css";

function App() {
	const match = location.pathname.match(/^\/p\/([a-z0-9-]+)/);
	const fixture = new URLSearchParams(location.search).get("fixture");
	if (match) return <Radar slug={match[1]} fixture={fixture} />;
	const center = location.pathname.match(/^\/c\/([a-z0-9-]+)/);
	if (center) return <Center slug={center[1]} />;
	return <Home />;
}

render(<App />, document.getElementById("app")!);
