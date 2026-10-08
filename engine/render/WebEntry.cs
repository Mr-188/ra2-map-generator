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
			};
			var engine = new RenderEngine();
			if (!engine.ConfigureFromSettings(settings)) return -1;
			return (int)engine.Execute();
		}
	}
}
