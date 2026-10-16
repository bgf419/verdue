// Builds Hoboken from a .hday file (hoboken-sim/scripts/export_unreal.mjs) and plays the simulated
// day on it: residents, people commuting in, visitors, dogs, bikes and cars as instanced meshes.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "HobokenDay.h"
#include "HobokenCrowd.generated.h"

class ADirectionalLight;
class UInstancedStaticMeshComponent;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UProceduralMeshComponent;
class UStaticMesh;

UCLASS(ClassGroup = (Hoboken), meta = (DisplayName = "Hoboken Crowd"))
class HOBOKENSIM_API AHobokenCrowd : public AActor
{
	GENERATED_BODY()

public:
	AHobokenCrowd();

	/** The day to play: a .hday file, relative to the project's Content folder or absolute. */
	UPROPERTY(EditAnywhere, Category = "Hoboken")
	FString DayFile = TEXT("Hoboken/hoboken-weekday.hday");

	/** Clock time to start from, in hours after midnight (the day runs from 4 am to 4 am). */
	UPROPERTY(EditAnywhere, Category = "Hoboken", meta = (ClampMin = "4.0", ClampMax = "27.99"))
	float StartHour = 7.5f;

	/** Simulated seconds per real second: 1 is real time, 60 is a minute every second. */
	UPROPERTY(EditAnywhere, Category = "Hoboken", meta = (ClampMin = "0.0"))
	float SimSecondsPerSecond = 30.0f;

	/** Build the streets, parks, water and buildings as well as the people. */
	UPROPERTY(EditAnywhere, Category = "Hoboken")
	bool bBuildCity = true;

	/** Draw both sides of every city triangle, so the city shows whichever way faces are culled. */
	UPROPERTY(EditAnywhere, Category = "Hoboken")
	bool bTwoSidedCity = true;

	/** Keep the clock running in the editor viewport, not only in Play. */
	UPROPERTY(EditAnywhere, Category = "Hoboken")
	bool bAnimateInEditor = false;

	/** Optional: a directional light (set to Movable) to point along the simulated sun. */
	UPROPERTY(EditAnywhere, Category = "Hoboken")
	TObjectPtr<ADirectionalLight> Sun;

	/** Read DayFile again and rebuild everything; also works in the editor. */
	UFUNCTION(CallInEditor, BlueprintCallable, Category = "Hoboken")
	void Reload();

	/** The simulated clock, in hours after midnight. */
	UFUNCTION(BlueprintPure, Category = "Hoboken")
	float GetClockHours() const { return Clock / 3600.0f; }

	UFUNCTION(BlueprintCallable, Category = "Hoboken")
	void SetClockHours(float Hours);

	virtual void Tick(float DeltaSeconds) override;
	virtual bool ShouldTickIfViewportsOnly() const override { return bAnimateInEditor; }

protected:
	virtual void BeginPlay() override;

private:
	bool LoadDay();
	void BuildCity();
	void UpdateFigures();
	void UpdateSun();
	UMaterialInstanceDynamic* MakeMaterial(const FLinearColor& Color);
	UInstancedStaticMeshComponent* MakeCrowd(const TCHAR* Name, UStaticMesh* Mesh);

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UProceduralMeshComponent> City;

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UInstancedStaticMeshComponent> Residents;

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UInstancedStaticMeshComponent> Commuters;

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UInstancedStaticMeshComponent> Visitors;

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UInstancedStaticMeshComponent> Cyclists;

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UInstancedStaticMeshComponent> Cars;

	UPROPERTY(VisibleAnywhere, Category = "Hoboken")
	TObjectPtr<UInstancedStaticMeshComponent> Dogs;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> BaseMaterial;

	UPROPERTY(Transient)
	TArray<TObjectPtr<UMaterialInstanceDynamic>> Materials;

	hoboken::Day Day;
	bool bLoaded = false;
	float Clock = 0.0f;
};
