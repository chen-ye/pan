import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { getDirTree } from "../src/services/files.ts";

Deno.test("getDirTree - builds directory structure correctly", async () => {
  // Setup temp directory
  const tempDir = await Deno.makeTempDir({ prefix: "pan_test_" });

  try {
    // Create directory structure
    // temp/
    //   dir1/
    //     subdir1/
    //   dir2/
    //   file1.txt

    await Deno.mkdir(join(tempDir, "dir1"));
    await Deno.mkdir(join(tempDir, "dir1", "subdir1"));
    await Deno.mkdir(join(tempDir, "dir2"));
    await Deno.writeTextFile(join(tempDir, "file1.txt"), "hello");

    // Run function
    const tree = await getDirTree(tempDir, tempDir);

    // Assertions
    assertEquals(tree.length, 2); // dir1, dir2

    // Sort order is generic (localeCompare), assuming dir1 comes before dir2 usually
    const dir1 = tree.find((n) => n.name === "dir1");
    const dir2 = tree.find((n) => n.name === "dir2");

    if (!dir1 || !dir2) throw new Error("Missing directories in output");

    assertEquals(dir1.path, "dir1");
    assertEquals(dir2.path, "dir2");

    assertEquals(dir1.children.length, 1);
    assertEquals(dir1.children[0].name, "subdir1");
    assertEquals(dir1.children[0].path, join("dir1", "subdir1"));

    assertEquals(dir2.children.length, 0);
  } finally {
    // Cleanup
    await Deno.remove(tempDir, { recursive: true });
  }
});
