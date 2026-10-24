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
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices.JavaScript;
using CNCMaps.Engine;
using CNCMaps.Engine.Map;
using CNCMaps.FileFormats;
using CNCMaps.FileFormats.Map;
using CNCMaps.FileFormats.VirtualFileSystem;
using CNCMaps.Shared;

namespace CNCMaps {
	public static partial class WebEntry {
		// The editor's interactive session: the first render keeps VFS/rules/art/
		// theater/map alive (RenderSettings.KeepAlive); every later edit calls
		// RenderUpdate, which re-reads the same map into that Map and draws again.
		private static RenderEngine _sessionEngine;
		private static Map _sessionMap;
		private static RenderSettings _sessionSettings;

		private static RenderSettings MakeSettings(string mapPath, string mixDir, string outPath,
			bool keepAlive, bool markStart) {
			return new RenderSettings {
				InputFile = mapPath,
				OutputFile = outPath,
				MixFilesDirectories = new List<string> { mixDir },
				Engine = EngineType.YurisRevenge,
				SavePNG = true,
				// PngWriter's level<=3 branch is deflate Fastest; pixels are lossless.
				PNGQuality = 3,
				MarkStartPos = markStart,
				StartPositionMarking = StartPositionMarking.Squared,
				MetadataOutFile = outPath + ".json",
				KeepAlive = keepAlive,
			};
		}
		/// <summary>
		/// Renders one map.
		/// </summary>
		/// <param name="mapPath">Map file, already written into the virtual filesystem.</param>
		/// <param name="mixDir">Directory of loose game files (theater tiles, art, palettes, INIs).</param>
		/// <param name="outPath">Output path WITHOUT an extension; ".png" is appended.</param>
		/// <returns>0 on success, -1 if the settings were rejected.</returns>
		[JSExport]
		public static int Render(string mapPath, string mixDir, string outPath) {
			// Generation preview: start markers on (the native renderer's own
			// `--mark-start-pos --start-pos-squared` flags), one-shot.
			var settings = MakeSettings(mapPath, mixDir, outPath, false, true);
			var engine = new RenderEngine();
			if (!engine.ConfigureFromSettings(settings)) return -1;
			return (int)engine.Execute();
		}

		/// <summary>
		/// Editor session start: the same render as Render(), but without start
		/// markers (the editor draws its own overlay) and with KeepAlive so
		/// RenderUpdate can reuse the loaded VFS/rules/art/theater/map.
		/// </summary>
		[JSExport]
		public static int RenderStart(string mapPath, string mixDir, string outPath) {
			_sessionEngine = null;
			_sessionMap = null;
			_sessionSettings = null;
			var settings = MakeSettings(mapPath, mixDir, outPath, true, false);
			var engine = new RenderEngine();
			if (!engine.ConfigureFromSettings(settings)) return -1;
			var rc = (int)engine.Execute();
			if (rc == 0 && engine.LastMap != null) {
				_sessionEngine = engine;
				_sessionMap = engine.LastMap;
				_sessionSettings = settings;
			}
			return rc;
		}

		/// <summary>
		/// Re-renders the same map after an edit, reusing the session's loaded
		/// renderer state.  Returns -2 when no session is alive and -3 when the
		/// map is not the same theater/size (caller falls back to RenderStart).
		/// </summary>
		[JSExport]
		public static int RenderUpdate(string mapPath, string outPath) {
			if (_sessionMap == null || _sessionSettings == null) return -2;
			try {
				var mapStream = File.Open(mapPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
				var mixMap = new MixFile(mapStream, mapPath, 0, mapStream.Length, false, false);
				VirtualFile vmapFile;
				if (mixMap.IsValid()) {
					var mapArchive = new MixFile(mapStream, Path.GetFileName(mapPath), true);
					var mixEntry = System.Linq.Enumerable.OrderByDescending(
						mapArchive.Index, me => me.Value.Length).First();
					vmapFile = mapArchive.OpenFile(mixEntry.Key);
				} else {
					vmapFile = new VirtualFile(mapStream, Path.GetFileName(mapPath), true);
				}
				var mapFile = new MapFile(vmapFile, Path.GetFileName(mapPath));
				// Execute() resets the renderer's RNG before every full render; the
				// reuse path has to do the same *before* the map objects are rebuilt,
				// because tiberium art is chosen while they are loaded.  Otherwise the
				// update continues the previous RNG and a few thousand ore pixels
				// differ from a fresh render.
				CNCMaps.Shared.Utility.Rand.Reset();
				if (!_sessionMap.Reload(mapFile)) return -3;

				_sessionMap.StartPosMarking = StartPositionMarking.None;
				_sessionMap.MarkOreFields = false;
				_sessionMap.Progress = null;
				_sessionMap.Draw();

				var saveRect = _sessionMap.GetSizePixels(SizeMode.Auto);
				var ds = _sessionMap.GetDrawingSurface();
				saveRect.Intersect(new System.Drawing.Rectangle(0, 0, ds.Width, ds.Height));
				_sessionSettings.OutputFile = outPath;
				_sessionSettings.OutputDir = "";
				ds.SavePNG(outPath + ".png", _sessionSettings.PNGQuality, saveRect);
				ds.FreeNonBitmap();
				return 0;
			} catch (System.Exception) {
				return -4;
			}
		}

		[JSExport]
		public static void RenderStop() {
			_sessionEngine = null;
			_sessionMap = null;
			_sessionSettings = null;
		}
	}
}
