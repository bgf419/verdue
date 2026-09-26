#include "HobokenCrowd.h"

#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SceneComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ProceduralMeshComponent.h"
#include "UObject/ConstructorHelpers.h"

DEFINE_LOG_CATEGORY_STATIC(LogHoboken, Log, All);

namespace
{
	// The browser view's colours: residents, people commuting in, visitors; then bikes, cars, dogs.
	const FColor GroupColors[] = { FColor(0x2a, 0x78, 0xd6), FColor(0xeb, 0x68, 0x34), FColor(0x1b, 0xaf, 0x7a) };
	const FColor BikeColor(0x2b, 0x2f, 0x33);
	const FColor CarColor(0x9a, 0xa0, 0xa6);
	const FColor DogColor(0x8a, 0x5a, 0x2b);

	uint8 ToByte(float Channel)
	{
		return static_cast<uint8>(FMath::Clamp(Channel * 255.0f + 0.5f, 0.0f, 255.0f));
	}

	/** Make a crowd show exactly these transforms, adding instances as needed and hiding the spare ones. */
	void Sync(UInstancedStaticMeshComponent* Crowd, TArray<FTransform>& Transforms)
	{
		static const FTransform Hidden(FRotator::ZeroRotator, FVector(0.0, 0.0, -100000.0), FVector(0.001));
		const int32 Have = Crowd->GetInstanceCount();
		if (Transforms.Num() > Have)
		{
			const TArray<FTransform> Extra(Transforms.GetData() + Have, Transforms.Num() - Have);
			Crowd->AddInstances(Extra, false);
			Transforms.SetNum(Have);
		}
		else
		{
			while (Transforms.Num() < Have)
			{
				Transforms.Add(Hidden);
			}
		}
		if (Transforms.Num() > 0)
		{
			Crowd->BatchUpdateInstancesTransforms(0, Transforms, false, true, true);
		}
	}
}

AHobokenCrowd::AHobokenCrowd()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Basic(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	CubeMesh = Cube.Object;
	CylinderMesh = Cylinder.Object;
	BaseMaterial = Basic.Object;

	City = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("City"));
	City->SetupAttachment(RootComponent);
	City->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	Residents = MakeCrowd(TEXT("Residents"), CylinderMesh);
	Commuters = MakeCrowd(TEXT("Commuters"), CylinderMesh);
	Visitors = MakeCrowd(TEXT("Visitors"), CylinderMesh);
	Cyclists = MakeCrowd(TEXT("Cyclists"), CubeMesh);
	Cars = MakeCrowd(TEXT("Cars"), CubeMesh);
	Dogs = MakeCrowd(TEXT("Dogs"), CubeMesh);
}

UInstancedStaticMeshComponent* AHobokenCrowd::MakeCrowd(const TCHAR* Name, UStaticMesh* Mesh)
{
	UInstancedStaticMeshComponent* Crowd = CreateDefaultSubobject<UInstancedStaticMeshComponent>(Name);
	Crowd->SetupAttachment(RootComponent);
	Crowd->SetStaticMesh(Mesh);
	Crowd->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Crowd->SetMobility(EComponentMobility::Movable);
	return Crowd;
}

void AHobokenCrowd::BeginPlay()
{
	Super::BeginPlay();
	Reload();
}

void AHobokenCrowd::Reload()
{
	if (!LoadDay())
	{
		return;
	}
	Materials.Reset();
	City->ClearAllMeshSections();
	if (bBuildCity)
	{
		BuildCity();
	}
	for (int32 Group = 0; Group < 3; Group++)
	{
		UInstancedStaticMeshComponent* Crowd = Group == 0 ? Residents.Get() : Group == 1 ? Commuters.Get() : Visitors.Get();
		Crowd->ClearInstances();
		Crowd->SetMaterial(0, MakeMaterial(FLinearColor(GroupColors[Group])));
	}
	Cyclists->ClearInstances();
	Cyclists->SetMaterial(0, MakeMaterial(FLinearColor(BikeColor)));
	Cars->ClearInstances();
	Cars->SetMaterial(0, MakeMaterial(FLinearColor(CarColor)));
	Dogs->ClearInstances();
	Dogs->SetMaterial(0, MakeMaterial(FLinearColor(DogColor)));
	SetClockHours(StartHour);
}

bool AHobokenCrowd::LoadDay()
{
	bLoaded = false;
	FString Path = DayFile;
	if (FPaths::IsRelative(Path))
	{
		Path = FPaths::Combine(FPaths::ProjectContentDir(), Path);
	}
	TArray<uint8> Bytes;
	if (!FFileHelper::LoadFileToArray(Bytes, *Path))
	{
		UE_LOG(LogHoboken, Error, TEXT("Couldn't read %s. Make it with: node hoboken-sim/scripts/export_unreal.mjs"), *Path);
		return false;
	}
	std::string Error;
	if (!Day.load(Bytes.GetData(), static_cast<size_t>(Bytes.Num()), &Error))
	{
		UE_LOG(LogHoboken, Error, TEXT("%s: %s"), *Path, UTF8_TO_TCHAR(Error.c_str()));
		return false;
	}
	bLoaded = true;
	UE_LOG(LogHoboken, Log, TEXT("Loaded %s: %d people, %d legs, %d city meshes"), *Path,
		static_cast<int32>(Day.agents.size()), static_cast<int32>(Day.legs.size()), static_cast<int32>(Day.meshes.size()));
	return true;
}

UMaterialInstanceDynamic* AHobokenCrowd::MakeMaterial(const FLinearColor& Color)
{
	if (!BaseMaterial)
	{
		return nullptr;
	}
	UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
	Material->SetVectorParameterValue(TEXT("Color"), Color);
	Materials.Add(Material);
	return Material;
}

void AHobokenCrowd::BuildCity()
{
	for (int32 Section = 0; Section < static_cast<int32>(Day.meshes.size()); Section++)
	{
		const hoboken::Mesh& Source = Day.meshes[Section];
		const int32 NumVerts = static_cast<int32>(Source.positions.size() / 3);
		const int32 NumIndices = static_cast<int32>(Source.indices.size());
		const int32 Copies = bTwoSidedCity ? 2 : 1;
		TArray<FVector> Vertices;
		TArray<FVector> Normals;
		TArray<int32> Triangles;
		Vertices.Reserve(NumVerts * Copies);
		Normals.Reserve(NumVerts * Copies);
		Triangles.Reserve(NumIndices * Copies);
		for (int32 Copy = 0; Copy < Copies; Copy++)
		{
			// The second copy faces the other way, with its normals flipped to match.
			const float Sign = Copy == 0 ? 1.0f : -1.0f;
			for (int32 i = 0; i < NumVerts; i++)
			{
				Vertices.Add(FVector(Source.positions[3 * i], Source.positions[3 * i + 1], Source.positions[3 * i + 2]));
				Normals.Add(FVector(Source.normals[3 * i], Source.normals[3 * i + 1], Source.normals[3 * i + 2]) * Sign);
			}
			const int32 Base = Copy * NumVerts;
			for (int32 i = 0; i + 2 < NumIndices; i += 3)
			{
				Triangles.Add(Base + static_cast<int32>(Source.indices[i]));
				Triangles.Add(Base + static_cast<int32>(Source.indices[Copy == 0 ? i + 1 : i + 2]));
				Triangles.Add(Base + static_cast<int32>(Source.indices[Copy == 0 ? i + 2 : i + 1]));
			}
		}
		City->CreateMeshSection_LinearColor(Section, Vertices, Triangles, Normals, TArray<FVector2D>(), TArray<FLinearColor>(),
			TArray<FProcMeshTangent>(), false);
		const hoboken::Material& Color = Day.materials[Source.material];
		City->SetMaterial(Section, MakeMaterial(FLinearColor(FColor(ToByte(Color.r), ToByte(Color.g), ToByte(Color.b)))));
	}
}

void AHobokenCrowd::SetClockHours(float Hours)
{
	if (!bLoaded)
	{
		return;
	}
	Clock = FMath::Clamp(Hours * 3600.0f, Day.dayStart, Day.dayEnd - 1.0f);
	UpdateFigures();
	UpdateSun();
}

void AHobokenCrowd::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!bLoaded)
	{
		return;
	}
	Clock += DeltaSeconds * SimSecondsPerSecond;
	if (Clock >= Day.dayEnd)
	{
		Clock = Day.dayStart + FMath::Fmod(Clock - Day.dayStart, Day.dayEnd - Day.dayStart);
	}
	UpdateFigures();
	UpdateSun();
}

void AHobokenCrowd::UpdateFigures()
{
	TArray<FTransform> People[3];
	TArray<FTransform> BikeTransforms;
	TArray<FTransform> CarTransforms;
	TArray<FTransform> DogTransforms;
	for (const hoboken::Figure& Figure : Day.evaluate(Clock))
	{
		const FRotator Facing(0.0f, Figure.yaw, 0.0f);
		const FVector At(Figure.x, Figure.y, 0.0f);
		const FVector Right = Facing.RotateVector(FVector(0.0f, 1.0f, 0.0f));
		if (Figure.mode == hoboken::Car)
		{
			// Keep to the right-hand side of the street.
			CarTransforms.Add(FTransform(Facing, At + Right * 180.0f + FVector(0.0f, 0.0f, 72.0f), FVector(4.4f, 1.85f, 1.45f)));
			continue;
		}
		if (Figure.mode == hoboken::Bike)
		{
			BikeTransforms.Add(FTransform(Facing, At + FVector(0.0f, 0.0f, 60.0f), FVector(1.7f, 0.45f, 1.2f)));
		}
		else
		{
			People[FMath::Min<int32>(Figure.group, 2)].Add(FTransform(Facing, At + FVector(0.0f, 0.0f, 87.5f), FVector(0.45f, 0.45f, 1.75f)));
		}
		if (Figure.dog)
		{
			DogTransforms.Add(FTransform(Facing, At + Right * 80.0f + FVector(0.0f, 0.0f, 25.0f), FVector(0.75f, 0.3f, 0.45f)));
		}
	}
	Sync(Residents, People[0]);
	Sync(Commuters, People[1]);
	Sync(Visitors, People[2]);
	Sync(Cyclists, BikeTransforms);
	Sync(Cars, CarTransforms);
	Sync(Dogs, DogTransforms);
}

void AHobokenCrowd::UpdateSun()
{
	if (!Sun)
	{
		return;
	}
	// Up in the east at sunrise, highest in the south at midday (about 49 degrees in late
	// September at Hoboken's latitude), down in the west at sunset, below the horizon at night.
	const float Daylight = (Clock - Day.sunrise) / FMath::Max(1.0f, Day.sunset - Day.sunrise);
	constexpr float Pi = 3.14159265f;
	const float Elevation = 49.0f * FMath::Sin(Pi * Daylight);
	const float Azimuth = 90.0f + 180.0f * Daylight;
	// A directional light points the way the light travels: from the sun toward the ground.
	Sun->SetActorRotation(FRotator(-Elevation, Azimuth + 180.0f, 0.0f));
}
