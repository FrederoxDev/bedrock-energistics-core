import {
  InternalRegisteredMachine,
  machineEntityToBlockIdMap,
  machineRegistry,
  StorageTypeColor,
  storageTypeRegistry,
  UiItemSlotElement,
  UiProgressIndicatorElementType,
  UiStorageBarUpdateOptions,
} from "./registry";
import {
  Container,
  DimensionLocation,
  Entity,
  ItemStack,
  Player,
  system,
  world,
} from "@minecraft/server";
import {
  MAX_MACHINE_STORAGE,
  STORAGE_AMOUNT_PER_BAR_SEGMENT,
} from "./constants";
import {
  getBlockUniqueId,
  getMachineSlotItem,
  getMachineStorage,
  machineItemStackToItemStack,
  setMachineSlotItem,
} from "./data";
import { stringifyDimensionLocation, truncateNumber } from "./utils/string";
import { makeErrorString } from "./utils/log";

export const PROGRESS_INDICATOR_MAX_VALUES: Record<
  UiProgressIndicatorElementType,
  number
> = {
  arrow: 16,
  flame: 13,
};

const STORAGE_TYPE_COLOR_TO_FORMATTING_CODE: Record<StorageTypeColor, string> =
  {
    black: "8",
    orange: "6",
    pink: "d",
    purple: "u",
    red: "4",
    yellow: "e",
  };

/**
 * key = machine entity
 * value = last player in UI
 */
const playersInUi = new Map<Entity, Player>();

/**
 * key = block uid (see getBlockUniqueId)
 * value = array of slot IDs that have changed
 */
export const machineChangedItemSlots = new Map<string, number[]>();

function isUiItem(item: ItemStack): boolean {
  return item.hasTag("fluffyalien_energisticscore:ui_item");
}

/**
 * @returns whether anything was cleared or not
 */
function clearUiItemsFromPlayer(player: Player): boolean {
  let anythingCleared = false;

  const playerCursorInventory = player.getComponent("cursor_inventory")!;
  if (playerCursorInventory.item && isUiItem(playerCursorInventory.item)) {
    playerCursorInventory.clear();
    anythingCleared = true;
  }

  const playerInventory = player.getComponent("inventory")!.container!;
  for (let i = 0; i < playerInventory.size; i++) {
    const item = playerInventory.getItem(i);

    if (item && isUiItem(item)) {
      playerInventory.setItem(i);
      anythingCleared = true;
    }
  }

  return anythingCleared;
}

function fillDisabledUiBar(inventory: Container, startIndex: number): void {
  const itemStack = new ItemStack(
    "fluffyalien_energisticscore:ui_disabled_storage_bar_segment",
  );
  itemStack.nameTag = "§rDisabled";

  inventory.setItem(startIndex, itemStack);
  inventory.setItem(startIndex + 1, itemStack);
  inventory.setItem(startIndex + 2, itemStack);
  inventory.setItem(startIndex + 3, itemStack);
}

function fillUiBar(
  segmentItemBaseId: string,
  labelColorCode: string,
  name: string,
  inventory: Container,
  amount: number,
  startIndex: number,
  change = 0,
): void {
  let remainingSegments = Math.floor(amount / STORAGE_AMOUNT_PER_BAR_SEGMENT);

  for (let i = startIndex + 3; i >= startIndex; i--) {
    const segments = Math.min(16, remainingSegments);
    remainingSegments -= segments;

    const itemStack = new ItemStack(segmentItemBaseId + segments.toString());

    itemStack.nameTag = `§r§${labelColorCode}${amount.toString()}/${MAX_MACHINE_STORAGE.toString()} ${name}`;
    if (change) {
      itemStack.nameTag += ` (${change < 0 ? "" : "+"}${truncateNumber(change, 2)}/t)`;
    }

    inventory.setItem(i, itemStack);
  }
}

function handleBarItems(
  location: DimensionLocation,
  inventory: Container,
  startIndex: number,
  player: Player,
  type: string = "_disabled",
  change = 0,
): void {
  for (let i = startIndex; i < startIndex + 4; i++) {
    const inventoryItem = inventory.getItem(i);
    if (inventoryItem?.hasTag("fluffyalien_energisticscore:ui_item")) {
      continue;
    }

    clearUiItemsFromPlayer(player);

    if (inventoryItem) {
      player.dimension.spawnItem(inventoryItem, player.location);
    }

    break;
  }

  if (type === "_disabled") {
    fillDisabledUiBar(inventory, startIndex);
    return;
  }

  if (!(type in storageTypeRegistry)) {
    throw new Error(
      makeErrorString(
        `can't update UI for block at ${stringifyDimensionLocation(location)}: storage type '${type}' does not exist`,
      ),
    );
  }

  const storageTypeOptions = storageTypeRegistry[type];

  fillUiBar(
    `fluffyalien_energisticscore:ui_storage_bar_segment_${storageTypeOptions.color}`,
    STORAGE_TYPE_COLOR_TO_FORMATTING_CODE[storageTypeOptions.color],
    storageTypeOptions.name,
    inventory,
    getMachineStorage(location, type),
    startIndex,
    change,
  );
}

function handleItemSlot(
  loc: DimensionLocation,
  inventory: Container,
  element: UiItemSlotElement,
  player: Player,
  init: boolean,
): void {
  const expectedMachineItem = getMachineSlotItem(loc, element.slotId);
  const expectedItemStack = machineItemStackToItemStack(
    element,
    expectedMachineItem,
  );

  const changedSlots = machineChangedItemSlots.get(getBlockUniqueId(loc));
  const slotChanged = changedSlots?.includes(element.slotId);

  const containerSlot = inventory.getSlot(element.index);

  if (slotChanged || init) {
    containerSlot.setItem(expectedItemStack);
    return;
  }

  if (!containerSlot.hasItem()) {
    clearUiItemsFromPlayer(player);
    setMachineSlotItem(loc, element.slotId, undefined, false);
    containerSlot.setItem(machineItemStackToItemStack(element));
    return;
  }

  if (containerSlot.isStackableWith(expectedItemStack)) {
    if (
      expectedMachineItem &&
      containerSlot.amount !== expectedItemStack.amount
    ) {
      setMachineSlotItem(
        loc,
        element.slotId,
        {
          typeIndex: expectedMachineItem.typeIndex,
          count: containerSlot.amount,
        },
        false,
      );
    }

    return;
  }

  clearUiItemsFromPlayer(player);

  const newTypeIndex = element.allowedItems.indexOf(containerSlot.typeId);
  if (
    newTypeIndex === -1 ||
    // ensure the item has no special properties
    !containerSlot.isStackableWith(new ItemStack(containerSlot.typeId))
  ) {
    setMachineSlotItem(loc, element.slotId, undefined, false);
    player.dimension.spawnItem(containerSlot.getItem()!, player.location);
    containerSlot.setItem(machineItemStackToItemStack(element));
    return;
  }

  setMachineSlotItem(
    loc,
    element.slotId,
    {
      typeIndex: newTypeIndex,
      count: containerSlot.amount,
    },
    false,
  );
}

function handleProgressIndicator(
  inventory: Container,
  index: number,
  indicator: UiProgressIndicatorElementType,
  player: Player,
  value = 0,
): void {
  const maxValue = PROGRESS_INDICATOR_MAX_VALUES[indicator];
  if (value < 0 || value > maxValue || !Number.isInteger(value)) {
    throw new Error(
      makeErrorString(
        `can't update UI: can't update progress indicator (indicator: '${indicator}'): expected 'value' to be an integer between 0 and ${maxValue.toString()} (inclusive) but got ${value.toString()}`,
      ),
    );
  }

  const inventoryItem = inventory.getItem(index);
  if (!inventoryItem?.hasTag("fluffyalien_energisticscore:ui_item")) {
    clearUiItemsFromPlayer(player);

    if (inventoryItem) {
      player.dimension.spawnItem(inventoryItem, player.location);
    }
  }

  inventory.setItem(
    index,
    new ItemStack(
      `fluffyalien_energisticscore:ui_progress_${indicator}${value.toString()}`,
    ),
  );
}

async function updateEntityUi(
  definition: InternalRegisteredMachine,
  entity: Entity,
  player: Player,
  init: boolean,
): Promise<void> {
  if (!definition.uiElements) {
    throw new Error(
      makeErrorString(
        `machine '${definition.id}' does not have 'description.ui' defined but has a machine entity`,
      ),
    );
  }

  if (!definition.updateUiEvent) {
    throw new Error(
      makeErrorString(
        `machine '${definition.id}' is missing the 'updateUi' handler but has 'description.ui' defined`,
      ),
    );
  }

  const dimensionLocation = {
    x: Math.floor(entity.location.x),
    y: Math.floor(entity.location.y),
    z: Math.floor(entity.location.z),
    dimension: entity.dimension,
  };

  const result = await definition.callUpdateUiHandler(dimensionLocation);

  // ensure the entity is still valid after invoking updateUi
  if (!entity.isValid()) {
    return;
  }

  const storageBarChanges: Record<string, UiStorageBarUpdateOptions> = {};

  let progressIndicators: Record<string, number> = {};

  if (result.storageBars) {
    for (const changeOptions of result.storageBars) {
      if (changeOptions.element in storageBarChanges) {
        storageBarChanges[changeOptions.element].change += changeOptions.change;
        continue;
      }

      storageBarChanges[changeOptions.element] = changeOptions;
    }
  }

  if (result.progressIndicators) {
    progressIndicators = {
      ...progressIndicators,
      ...result.progressIndicators,
    };
  }

  const inventory = entity.getComponent("inventory")!.container!;

  for (const [id, options] of Object.entries(definition.uiElements)) {
    switch (options.type) {
      case "storageBar": {
        const changeOptions = storageBarChanges[id] as
          | UiStorageBarUpdateOptions
          | undefined;

        if (changeOptions) {
          handleBarItems(
            dimensionLocation,
            inventory,
            options.startIndex,
            player,
            changeOptions.type,
            changeOptions.change,
          );
          break;
        }

        handleBarItems(
          dimensionLocation,
          inventory,
          options.startIndex,
          player,
        );
        break;
      }
      case "itemSlot":
        handleItemSlot(dimensionLocation, inventory, options, player, init);
        break;
      case "progressIndicator":
        handleProgressIndicator(
          inventory,
          options.index,
          options.indicator,
          player,
          progressIndicators[id],
        );
        break;
    }
  }

  machineChangedItemSlots.clear();
}

world.afterEvents.playerInteractWithEntity.subscribe((e) => {
  if (
    !e.target.matches({
      families: ["fluffyalien_energisticscore:machine_entity"],
    })
  ) {
    return;
  }

  const machineId = machineEntityToBlockIdMap[e.target.typeId] as
    | string
    | undefined;
  if (!machineId) {
    throw new Error(
      makeErrorString(
        `can't process playerInteractWithEntity event for machine entity '${e.target.typeId}': this entity has the 'fluffyalien_energisticscore:machine_entity' type family but it is not attached to a machine`,
      ),
    );
  }

  playersInUi.set(e.target, e.player);
  const definition = machineRegistry[machineId];
  void updateEntityUi(definition, e.target, e.player, true);
});

world.afterEvents.entitySpawn.subscribe((e) => {
  if (e.entity.typeId !== "minecraft:item") return;

  const itemStack = e.entity.getComponent("item")!.itemStack;

  if (isUiItem(itemStack)) {
    e.entity.remove();
  }
});

system.runInterval(() => {
  for (const [entity, player] of playersInUi) {
    if (!entity.isValid()) {
      playersInUi.delete(entity);
      continue;
    }

    const definition = machineRegistry[entity.typeId];
    if (definition.persistentEntity) {
      const players = entity.dimension.getPlayers({
        location: entity.location,
        maxDistance: 10,
      });
      if (!players.length) {
        playersInUi.delete(entity);
        continue;
      }
    }

    void updateEntityUi(definition, entity, player, false);
  }
}, 5);
