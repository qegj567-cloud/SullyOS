// Kitchen furniture groups keep the work aisle and coffee station reachable.
export const FURNITURE_GROUPS={
  "kitchenWork": {
    "members": [
      [
        "kitchen_fridge",
        -3.48,
        0,
        0,
        "#25272a"
      ],
      [
        "show_kitchen_counter",
        -0.3,
        0,
        0,
        "#f3f3f1"
      ],
      [
        "show_kitchen_range",
        3.18,
        0,
        0,
        "#f3f3f1"
      ]
    ]
  },
  "islandDining": {
    "members": [
      [
        "show_kitchen_island",
        0,
        0,
        0,
        "#f3f3f1"
      ],
      [
        "show_kitchen_bench",
        0,
        1.42,
        180,
        "#36383b"
      ]
    ]
  },
  "coffeeCorner": {
    "members": [
      [
        "show_bedroom_dresser",
        0,
        0,
        90,
        "#f3f3f1"
      ]
    ]
  }
};
export const SHOWROOM_ZONES={
  "kitchen": [
    {
      "id": "work",
      "group": "kitchenWork",
      "at": [
        0,
        -3.15
      ]
    },
    {
      "id": "dining",
      "group": "islandDining",
      "at": [
        0,
        0
      ]
    },
    {
      "id": "coffee",
      "group": "coffeeCorner",
      "at": [
        -3.85,
        1.05
      ]
    },
    {
      "id": "storage",
      "members": [
        [
          "kitchen_ref_rack",
          3.95,
          0.1,
          270
        ],
        [
          "kitchen_ref_trolley",
          3.8,
          1.45,
          270
        ]
      ]
    },
    {
      "id": "textiles",
      "members": [
        [
          "kitchen_ref_runner",
          -0.3,
          -2.15
        ],
        [
          "kitchen_ref_mat",
          0,
          2.9
        ]
      ]
    },
    {
      "id": "edges",
      "members": [
        [
          "suite_plant_large",
          3.75,
          2.95
        ]
      ]
    }
  ]
};
export function groupItems(zone){
 const members=zone.group?FURNITURE_GROUPS[zone.group]?.members:zone.members;
 if(!members)throw Error('找不到家具组合：'+zone.group);
 const [x,z]=zone.at||[0,0],rotation=zone.rotation||0,angle=rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
 return members.map(([id,dx,dz,r=0,color=null])=>[id,+(x+c*dx+s*dz).toFixed(4),+(z-s*dx+c*dz).toFixed(4),(r+rotation)%360,color]);
}
export function showroomItems(key){return SHOWROOM_ZONES[key].flatMap(groupItems);}

// Per-instance finishes: keep the library's original wood/pastel options.
export const KITCHEN_MATERIAL_COLORS={
 show_bedroom_dresser:{woodLight:'#242629','showroom-charcoal':'#202225'},
 show_kitchen_counter:{woodLight:'#242629','showroom-charcoal':'#202225','showroom-blue':'#969ea4','showroom-stone':'#858b91'},
 show_kitchen_range:{woodLight:'#242629','showroom-charcoal':'#202225','showroom-stone':'#858b91'},
 show_kitchen_island:{woodLight:'#242629','showroom-charcoal':'#202225'},
 kitchen_fridge:{'kitchen-cream':'#ececed','kitchen-dark':'#202225','kitchen-ceramic':'#f3f3f1','kitchen-pink':'#c6c8ca','kitchen-fruit':'#a2a6aa','kitchen-metal':'#969b9f'},
 kitchen_bin:{'kitchen-cream':'#ececed','kitchen-metal':'#969b9f'},
};
