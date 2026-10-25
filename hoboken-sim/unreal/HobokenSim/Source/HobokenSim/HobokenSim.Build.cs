using UnrealBuildTool;

public class HobokenSim : ModuleRules
{
	public HobokenSim(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "ProceduralMeshComponent" });
	}
}
