{
  "targets": [
    {
      "target_name": "process_tree",
      "sources": ["process_tree.c"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "CompileAs": "1",
          "RuntimeLibrary": "0",
          "AdditionalOptions": ["/std:c17"]
        }
      }
    }
  ]
}
