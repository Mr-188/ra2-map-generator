// Browser entry point for the CNCMaps renderer.
//
// This file is OURS, not upstream: engine/build_render_web.sh copies it into the
// reference project before publishing.  It only translates a call from
// JavaScript into the renderer's own configuration objects, so no rendering
// logic is duplicated or reimplemented.
//
// It deliberately does NOT go through Program.Main's argv.  That path parses
// arguments with System.CommandLine, which is reflection-heavy and throws
// Arg_IndexOutOfRangeException inside a trimmed browser-wasm build -- the very
// same argument vector works natively, which is what identifies trimming as the
// cause rather than the arguments.  ConfigureFromSettings is the supported way
// in, and it is what the GUI uses too.
using System.Collections.Generic;
using System.Runtime.InteropServices.JavaScript;
using CNCMaps.Engine;
using CNCMaps.Shared;

namespace CNCMaps {
	public static partial class WebEntry {
		/// <summary>
		/// Renders one map.
		/// </summary>
		/// <param name="mapPath">Map file, already written into the virtual filesystem.</param>
		/// <param name="mixDir">Directory of loose game files (theater tiles, art, palettes, INIs).</param>
		/// <param name="outPath">Output path WITHOUT an extension; ".png" is appended.</param>
		/// <returns>0 on success, -1 if the settings were rejected.</returns>
		[JSExport]
		public static int Render(string mapPath, string mixDir, string outPath) {
			var settings = new RenderSettings {
				InputFile = mapPath,
				OutputFile = outPath,
				MixFilesDirectories = new List<string> { mixDir },
				Engine = EngineType.YurisRevenge,
				SavePNG = true,
				// Mark the start positions, as the renderer's own CLI does with
				// `--mark-start-pos --start-pos-squared` (red squares, 2x2 cells at the
				// default marker size).  tools/verify_render.py passes the same two flags
				// to the native renderer, so the page's "pixel-identical to a native
				// CNCMaps render" caption stays true - turning this on in only one of the
				// two paths would break exactly that claim.  The markers come from
				// [Waypoints] / the map's starting points, so a map with fewer than 8
				// players gets one square per real start and none for the 0,0 padding
				// (DrawStartPositions skips nothing, but the padding entries all land on
				// the same corner tile - kept as upstream draws them).
				MarkStartPos = true,
				StartPositionMarking = StartPositionMarking.Squared,
				// The page lets the player move the start positions on the preview and
				// re-render, so it has to turn a click in the saved PNG back into a map
				// cell.  The renderer already resolves that transform exactly - the crop
				// origin, the tile size and every start position's surface pixel - and
				// writes it next to the image with `--meta-json`.  Asking for the same
				// file here means the page never keeps its own copy of the projection,
				// which is the rule the whole project follows: one implementation, and
				// the UI reads it.
				MetadataOutFile = outPath + ".json",
			};
			var engine = new RenderEngine();
			if (!engine.ConfigureFromSettings(settings)) return -1;
			return (int)engine.Execute();
		}
	}
}
