{
  description = "cloud-mem: long-term memory MCP server on Cloudflare Workers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.wrangler
            ];
            # The workerd that npm installs for the test pool is a generic
            # dynamically linked binary that NixOS can't run. Use the patched
            # one bundled with the Nix wrangler instead.
            MINIFLARE_WORKERD_PATH = "${pkgs.wrangler}/lib/node_modules/.bin/workerd";
          };
        }
      );
    };
}
