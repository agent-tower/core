#!/usr/bin/env python3
from pathlib import Path
from statistics import median

from PIL import Image

GRID_SIZE = 5
TARGET_SIZE = 256
BACKGROUND_DISTANCE_THRESHOLD = 24
ALPHA_THRESHOLD = 16

NAMES = [
    "developer",
    "architect",
    "tester",
    "devops",
    "data-scientist",
    "frontend",
    "backend",
    "security",
    "project-manager",
    "product-manager",
    "scrum-master",
    "tech-lead",
    "coordinator",
    "mentor",
    "reviewer",
    "ui-designer",
    "ux-researcher",
    "documenter",
    "translator",
    "analyst",
    "consultant",
    "creative-director",
    "support",
    "assistant",
    "robot",
]


def estimate_background(image: Image.Image) -> tuple[int, int, int]:
    width, height = image.size
    pixels = image.load()
    samples: list[tuple[int, int, int]] = []

    for x in range(width):
        samples.append(pixels[x, 0][:3])
        samples.append(pixels[x, height - 1][:3])
    for y in range(height):
        samples.append(pixels[0, y][:3])
        samples.append(pixels[width - 1, y][:3])

    return tuple(round(median(sample[channel] for sample in samples)) for channel in range(3))


def foreground_bbox(image: Image.Image, background: tuple[int, int, int]) -> tuple[int, int, int, int] | None:
    width, height = image.size
    pixels = image.load()
    left, top = width, height
    right, bottom = -1, -1

    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            distance = abs(red - background[0]) + abs(green - background[1]) + abs(blue - background[2])
            if alpha > ALPHA_THRESHOLD and distance > BACKGROUND_DISTANCE_THRESHOLD:
                left = min(left, x)
                top = min(top, y)
                right = max(right, x)
                bottom = max(bottom, y)

    if right < left or bottom < top:
        return None
    return (left, top, right + 1, bottom + 1)


def recenter_avatar(image: Image.Image) -> Image.Image:
    background = estimate_background(image)
    bbox = foreground_bbox(image, background)
    if bbox is None:
        return image

    left, top, right, bottom = bbox
    center_x = (left + right) / 2
    center_y = (top + bottom) / 2
    shift_x = round((TARGET_SIZE / 2) - center_x)
    shift_y = round((TARGET_SIZE / 2) - center_y)

    # Do not let the foreground clip if a future source grid has tighter crops.
    shift_x = max(-left, min(TARGET_SIZE - right, shift_x))
    shift_y = max(-top, min(TARGET_SIZE - bottom, shift_y))

    canvas = Image.new("RGBA", image.size, (*background, 255))
    canvas.paste(image, (shift_x, shift_y), image)
    return canvas


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    out_dir = root / "public" / "avatars" / "presets"
    source = out_dir / "avatar-preset-grid.png"

    image = Image.open(source).convert("RGBA")
    width, height = image.size
    cell_width = width / GRID_SIZE
    cell_height = height / GRID_SIZE

    for index, name in enumerate(NAMES):
        column = index % GRID_SIZE
        row = index // GRID_SIZE
        box = (
            round(column * cell_width),
            round(row * cell_height),
            round((column + 1) * cell_width),
            round((row + 1) * cell_height),
        )
        avatar = image.crop(box).resize((TARGET_SIZE, TARGET_SIZE), Image.Resampling.LANCZOS)
        avatar = recenter_avatar(avatar)
        avatar.save(out_dir / f"avatar-preset-{index + 1:02d}-{name}.png", optimize=True)


if __name__ == "__main__":
    main()
